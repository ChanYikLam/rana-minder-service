import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryInvitationRepository } from '../../infrastructure/invitation-repository';
import { DefaultCasdoorRelationPort } from '../../infrastructure/casdoor-relation-port';
import { CreateInvitationCommand } from './create-invitation.command';
import { AcceptInvitationCommand } from './accept-invitation.command';
import { RejectInvitationCommand } from './reject-invitation.command';
import { WithdrawInvitationCommand } from './withdraw-invitation.command';
import { ExpireInvitationCommand } from './expire-invitation.command';
import { ForceInvalidateInvitationCommand } from './force-invalidate.command';
import { ReissueInvitationCommand } from './reissue-invitation.command';
import { ResolveActivationCommand } from './resolve-activation.command';
import { InvitationStatusQuery } from '../queries/invitation-status.query';
import { InvitationStateMachine } from '../../domain/state-machines/invitation-state-machine';
import { InvitationPolicy } from '../../domain/services/invitation-policy';
import type {
  CasdoorRelationPort,
  CasdoorRelationResult,
} from '../../infrastructure/casdoor-relation-port';

/** 测试用可编排 Casdoor 端口（模拟写回读确认失败/成功） */
class StubCasdoorPort implements CasdoorRelationPort {
  private readonly outcomes: CasdoorRelationResult[];
  constructor(...outcomes: CasdoorRelationResult[]) {
    this.outcomes = outcomes;
  }
  async writeAndReadBackGroup(): Promise<CasdoorRelationResult> {
    const next = this.outcomes.shift();
    if (next === undefined) {
      return { ok: true, confirmed: true };
    }
    return next;
  }
}

const makeRig = () => {
  const repo = new InMemoryInvitationRepository();
  const sm = new InvitationStateMachine();
  const policy = new InvitationPolicy();
  const create = new CreateInvitationCommand(repo, policy, sm);
  const accept = new AcceptInvitationCommand(repo, policy, sm);
  const reject = new RejectInvitationCommand(repo, policy, sm);
  const withdraw = new WithdrawInvitationCommand(repo, policy, sm);
  const expire = new ExpireInvitationCommand(repo, sm);
  const forceInvalidate = new ForceInvalidateInvitationCommand(repo, sm);
  const reissue = new ReissueInvitationCommand(repo, policy, sm);
  const resolveActivation = new ResolveActivationCommand(repo, new DefaultCasdoorRelationPort());
  const status = new InvitationStatusQuery(repo);
  return {
    repo,
    create,
    accept,
    reject,
    withdraw,
    expire,
    forceInvalidate,
    reissue,
    resolveActivation,
    status,
  };
};

const createInput = {
  issuerId: 'hr1',
  issuerRoles: ['HR_ADMIN'],
  inviteeId: 'stu1',
  clubId: 'c1',
  decisionRef: 'dec-1',
  expiresAt: '2099-01-01T00:00:00.000Z',
};

describe('4.5.1 普通录取邀请（INV-001、REC-024/026）', () => {
  it('创建：负责人/人事可发；部门负责人/成员无权（IFC-ERR-003）', async () => {
    const rig = makeRig();
    const inv = await rig.create.execute(createInput);
    assert.equal(inv.status, 'PENDING');
    // 部门负责人无权
    await assert.rejects(
      rig.create.execute({ ...createInput, issuerRoles: ['DEPARTMENT_LEADER'] }),
      /IFC-ERR-003/,
    );
    // 成员无权
    await assert.rejects(
      rig.create.execute({ ...createInput, issuerRoles: ['MEMBER'] }),
      /IFC-ERR-003/,
    );
  });

  it('同社团同对象最多一份待处理邀请（IFC-ERR-009 幂等冲突）', async () => {
    const rig = makeRig();
    await rig.create.execute(createInput);
    await assert.rejects(rig.create.execute(createInput), /IFC-ERR-009/);
  });

  it('接受：指定本人、成员业务生效时间=接受时间、生效处理中（REC-026/ORG-027）', async () => {
    const rig = makeRig();
    const inv = await rig.create.execute(createInput);
    const accepted = await rig.accept.execute({
      invitationId: inv.invitationId,
      principalId: 'stu1',
      eligibilityOk: true,
    });
    assert.equal(accepted.status, 'ACCEPTED');
    assert.ok(accepted.acceptedAt !== null);
    // 成员业务生效时间 = 接受时间
    assert.equal(accepted.activation?.memberEffectiveAt, accepted.acceptedAt);
    // 回读确认前：生效处理中，不开放权限
    assert.equal(accepted.activation?.status, 'PROCESSING');
    const view = await rig.status.getStatus(inv.invitationId);
    assert.equal(view.accepted, true);
    assert.equal(view.activationStatus, 'PROCESSING');
  });

  it('接受不可逆：不能撤销/改回待处理；重复接受返回原结果（幂等）', async () => {
    const rig = makeRig();
    const inv = await rig.create.execute(createInput);
    const accepted = await rig.accept.execute({
      invitationId: inv.invitationId,
      principalId: 'stu1',
      eligibilityOk: true,
    });
    // 重复接受 → 返回原结果
    const again = await rig.accept.execute({
      invitationId: inv.invitationId,
      principalId: 'stu1',
      eligibilityOk: true,
    });
    assert.equal(again.status, 'ACCEPTED');
    assert.equal(again.version, accepted.version);
    // 已接受不可撤回
    await assert.rejects(
      rig.withdraw.execute({
        invitationId: inv.invitationId,
        principalId: 'hr1',
        principalRoles: ['HR_ADMIN'],
      }),
      /仅待处理邀请可撤回/,
    );
  });

  it('单胜者：接受与撤回竞争只一个成功（版本比较并交换）', async () => {
    const rig = makeRig();
    const inv = await rig.create.execute(createInput);
    const loaded1 = await rig.repo.load(inv.invitationId);
    // 先撤回（用撤回前的版本快照模拟并发：接受用旧版本 CAS 应失败）
    await rig.withdraw.execute({
      invitationId: inv.invitationId,
      principalId: 'hr1',
      principalRoles: ['HR_ADMIN'],
    });
    const stale = { ...loaded1! }; // 旧版本
    const accepted = { ...stale, status: 'ACCEPTED' as const, version: stale.version + 1 };
    const swapped = await rig.repo.compareAndSwap(stale, accepted);
    assert.equal(swapped, false); // 撤回已提交 → 接受失败（单胜者）
    const after = await rig.repo.load(inv.invitationId);
    assert.equal(after!.status, 'WITHDRAWN');
  });

  it('拒绝：本人、待处理可拒绝；重发后旧邀请保留不修改', async () => {
    const rig = makeRig();
    const inv = await rig.create.execute(createInput);
    const rejected = await rig.reject.execute({
      invitationId: inv.invitationId,
      principalId: 'stu1',
    });
    assert.equal(rejected.status, 'REJECTED');
    // 非本人拒绝 → 拒绝
    await assert.rejects(
      rig.reject.execute({ invitationId: inv.invitationId, principalId: 'other' }),
      /IFC-ERR-003/,
    );
  });

  it('过期：系统截止任务幂等；冻结时不得过期', async () => {
    const rig = makeRig();
    const inv = await rig.create.execute(createInput);
    const expired = await rig.expire.execute({
      invitationId: inv.invitationId,
      expiryAllowed: true,
    });
    assert.equal(expired!.status, 'EXPIRED');
    // 冻结（活动暂停）→ 不转换
    const inv2 = await rig.create.execute({ ...createInput, inviteeId: 'stu2' });
    const frozen = await rig.expire.execute({
      invitationId: inv2.invitationId,
      expiryAllowed: false,
    });
    assert.equal(frozen!.status, 'PENDING');
  });

  it('强制失效：待处理→强制失效；已接受不受影响', async () => {
    const rig = makeRig();
    const pending = await rig.create.execute(createInput);
    const invalidated = await rig.forceInvalidate.execute({
      invitationId: pending.invitationId,
      source: 'ACTIVITY_CANCELLED',
    });
    assert.equal(invalidated!.status, 'FORCE_INVALIDATED');
    // 已接受不受影响
    const acceptedInv = await rig.create.execute({ ...createInput, inviteeId: 'stu2' });
    await rig.accept.execute({
      invitationId: acceptedInv.invitationId,
      principalId: 'stu2',
      eligibilityOk: true,
    });
    const kept = await rig.forceInvalidate.execute({
      invitationId: acceptedInv.invitationId,
      source: 'ACTIVITY_CANCELLED',
    });
    assert.equal(kept!.status, 'ACCEPTED');
  });

  it('重发：已拒绝/已过期/已撤回/强制失效可重发（新邀请对象，旧保留）；已接受不可重发', async () => {
    const rig = makeRig();
    // 已拒绝可重发
    const inv = await rig.create.execute(createInput);
    await rig.reject.execute({ invitationId: inv.invitationId, principalId: 'stu1' });
    const fresh = await rig.reissue.execute({
      oldInvitationId: inv.invitationId,
      issuerId: 'hr1',
      issuerRoles: ['HR_ADMIN'],
      newExpiresAt: '2099-02-01T00:00:00.000Z',
      eligibilityOk: true,
    });
    assert.equal(fresh.status, 'PENDING');
    assert.notEqual(fresh.invitationId, inv.invitationId);
    assert.equal(fresh.history[0].note, `reissue-of:${inv.invitationId}`);
    // 旧邀请保留（REJECTED 不修改）
    const old = await rig.repo.load(inv.invitationId);
    assert.equal(old!.status, 'REJECTED');
    // 已接受不可重发
    const acceptedInv = await rig.create.execute({ ...createInput, inviteeId: 'stu2' });
    await rig.accept.execute({
      invitationId: acceptedInv.invitationId,
      principalId: 'stu2',
      eligibilityOk: true,
    });
    await assert.rejects(
      rig.reissue.execute({
        oldInvitationId: acceptedInv.invitationId,
        issuerId: 'hr1',
        issuerRoles: ['HR_ADMIN'],
        newExpiresAt: '2099-02-01T00:00:00.000Z',
        eligibilityOk: true,
      }),
      /不可重发/,
    );
  });

  it('激活解析：回读确认 → 已生效；15 分钟仍失败 → 同步失败待重试（保持已接受、成员未生效）', async () => {
    const rig = makeRig();
    const inv = await rig.create.execute(createInput);
    await rig.accept.execute({
      invitationId: inv.invitationId,
      principalId: 'stu1',
      eligibilityOk: true,
    });
    // 回读确认成功 → 已生效
    const ok = await rig.resolveActivation.execute({
      invitationId: inv.invitationId,
      deadlineExceeded: false,
    });
    assert.equal(ok.activated, true);
    assert.equal(ok.invitation.activation?.status, 'ACTIVATED');
  });

  it('激活解析：同步失败待重试不可回退到处理中（状态单调）；成功后激活', async () => {
    const rig = makeRig();
    const inv = await rig.create.execute(createInput);
    await rig.accept.execute({
      invitationId: inv.invitationId,
      principalId: 'stu1',
      eligibilityOk: true,
    });
    const casdoor = new StubCasdoorPort(
      { ok: false, confirmed: false, reason: 'write-timeout' }, // 第 1 次失败
      { ok: false, confirmed: false, reason: 'write-timeout' }, // 第 2 次仍失败（未到期）
      { ok: true, confirmed: true }, // 第 3 次成功
    );
    const resolve = new ResolveActivationCommand(rig.repo, casdoor);

    // 15 分钟到期且失败 → 同步失败待重试
    const first = await resolve.execute({ invitationId: inv.invitationId, deadlineExceeded: true });
    assert.equal(first.invitation.activation?.status, 'SYNC_FAILED_PENDING_RETRY');
    assert.equal(first.activated, false);

    // 再次失败、且未到期：已进入同步失败待重试后不可回退到 PROCESSING
    const second = await resolve.execute({
      invitationId: inv.invitationId,
      deadlineExceeded: false,
    });
    assert.equal(second.invitation.activation?.status, 'SYNC_FAILED_PENDING_RETRY');

    // 回读确认成功 → 激活
    const third = await resolve.execute({
      invitationId: inv.invitationId,
      deadlineExceeded: false,
    });
    assert.equal(third.activated, true);
    assert.equal(third.invitation.activation?.status, 'ACTIVATED');
  });

  it('激活解析：CAS 竞争失败时重新加载返回最新状态（单胜者收敛、不抛错）', async () => {
    const rig = makeRig();
    const inv = await rig.create.execute(createInput);
    await rig.accept.execute({
      invitationId: inv.invitationId,
      principalId: 'stu1',
      eligibilityOk: true,
    });
    // 模拟并发激活任务已推进：仓储 compareAndSwap 永远失败
    class FailingCasRepo extends InMemoryInvitationRepository {
      override async compareAndSwap(): Promise<boolean> {
        return false;
      }
    }
    const failingRepo = new FailingCasRepo();
    const loaded = await rig.repo.load(inv.invitationId);
    await failingRepo.save(loaded!); // 已接受但回读未确认（PROCESSING）
    const casdoor = new StubCasdoorPort({ ok: false, confirmed: false, reason: 'write-timeout' });
    const resolve = new ResolveActivationCommand(failingRepo, casdoor);
    // 竞争失败：不抛错，重新加载返回当前（未激活）状态
    const out = await resolve.execute({ invitationId: inv.invitationId, deadlineExceeded: true });
    assert.equal(out.activated, false);
    assert.notEqual(out.invitation.activation?.status, 'ACTIVATED');
  });
});
