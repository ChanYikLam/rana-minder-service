import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryRoutineInvitationRepository } from '../../infrastructure/routine-invitation-repository';
import type { CasdoorCompositeResult } from '../../infrastructure/casdoor-relation-port';
import {
  CreateRoutineInvitationCommand,
  CreateRoutineError,
} from './create-routine-invitation.command';
import { AcceptRoutineInvitationCommand } from './accept-routine-invitation.command';
import { RejectRoutineInvitationCommand } from './routine-reject-withdraw.command';
import { WithdrawRoutineInvitationCommand } from './routine-reject-withdraw.command';
import { ExpireRoutineInvitationCommand } from './expire-routine-invitation.command';
import {
  ReissueRoutineInvitationCommand,
  ReissueRoutineError,
} from './reissue-routine-invitation.command';
import type { RoutineInvitation } from '../../domain/models/routine-invitation';
import { ResolveRoutineActivationCommand } from './resolve-routine-activation.command';
import { RoutineInvitationStatusQuery } from '../queries/routine-status.query';
import { RoutineInvitationStateMachine } from '../../domain/state-machines/routine-invitation-state-machine';
import { InvitationPolicy } from '../../domain/services/invitation-policy';

/** 组合回读结果可注入（测试部分确认/高优先级场景） */
const makeCasdoor = (impl: (department?: string | null) => Promise<CasdoorCompositeResult>) => ({
  writeAndReadBackGroup: async () => ({ ok: true, confirmed: true }),
  writeAndReadBackRelations: (club: string, principal: string, department?: string | null) =>
    impl(department),
});

const makeRig = (
  casdoor = makeCasdoor(async () => ({ groupConfirmed: true, departmentConfirmed: true })),
) => {
  const repo = new InMemoryRoutineInvitationRepository();
  const sm = new RoutineInvitationStateMachine();
  const policy = new InvitationPolicy();
  return {
    repo,
    create: new CreateRoutineInvitationCommand(repo, policy, sm),
    accept: new AcceptRoutineInvitationCommand(repo, policy, sm),
    reject: new RejectRoutineInvitationCommand(repo, policy, sm),
    withdraw: new WithdrawRoutineInvitationCommand(repo, policy, sm),
    expire: new ExpireRoutineInvitationCommand(repo, sm),
    reissue: new ReissueRoutineInvitationCommand(repo, policy, sm),
    resolve: new ResolveRoutineActivationCommand(repo, casdoor as never, sm),
    status: new RoutineInvitationStatusQuery(repo),
  };
};

const createInput = {
  issuerId: 'hr1',
  issuerRoles: ['HR_ADMIN'],
  inviteeId: 'stu1',
  clubId: 'c1',
  initialDepartmentId: 'd1',
  expiresAt: '2099-01-01T00:00:00.000Z',
  accountValid: true,
  notMemberYet: true,
  departmentValid: true,
};

describe('4.5.2 常规入社邀请（MEM-004、SRS-SM-MEM-004）', () => {
  it('创建：负责人/人事可发；部门负责人/面试官/成员不能发（IFC-ERR-003）', async () => {
    const rig = makeRig();
    const inv = await rig.create.execute(createInput);
    assert.equal(inv.status, 'PENDING');
    assert.equal(inv.initialDepartmentId, 'd1');
    for (const role of ['DEPARTMENT_LEADER', 'INTERVIEWER', 'MEMBER']) {
      await assert.rejects(
        rig.create.execute({ ...createInput, issuerRoles: [role] }),
        /IFC-ERR-003/,
      );
    }
  });

  it('创建约束：目标已是成员/部门无效/重复待处理 → 拒绝', async () => {
    const rig = makeRig();
    await assert.rejects(
      rig.create.execute({ ...createInput, notMemberYet: false }),
      /已是本社团成员/,
    );
    await assert.rejects(
      rig.create.execute({ ...createInput, departmentValid: false }),
      /初始部门无效/,
    );
    await rig.create.execute(createInput);
    await assert.rejects(rig.create.execute(createInput), /IFC-ERR-009/);
  });

  it('整体接受 → 已接受待生效（不开放权限）；重复接受幂等', async () => {
    const rig = makeRig();
    const inv = await rig.create.execute(createInput);
    const accepted = await rig.accept.execute({
      routineInvitationId: inv.routineInvitationId,
      principalId: 'stu1',
      eligibilityOk: true,
      alreadyMember: false,
    });
    assert.equal(accepted.status, 'ACCEPTED_PENDING_ACTIVATION');
    assert.equal(accepted.syncStatus, 'PENDING');
    // 幂等：重复接受返回原结果
    const again = await rig.accept.execute({
      routineInvitationId: inv.routineInvitationId,
      principalId: 'stu1',
      eligibilityOk: true,
      alreadyMember: false,
    });
    assert.equal(again.status, 'ACCEPTED_PENDING_ACTIVATION');
    // 未生效 → 页面显示生效处理中
    const view = await rig.status.getStatus(inv.routineInvitationId);
    assert.equal(view.activationPending, true);
    assert.equal(view.activated, false);
  });

  it('接受时回读已是成员 → 目标已成为成员（不记录为本邀请已接受）', async () => {
    const rig = makeRig();
    const inv = await rig.create.execute(createInput);
    const closed = await rig.accept.execute({
      routineInvitationId: inv.routineInvitationId,
      principalId: 'stu1',
      eligibilityOk: true,
      alreadyMember: true,
    });
    assert.equal(closed.status, 'TARGET_ALREADY_MEMBER');
    assert.equal(closed.acceptedAt, null);
  });

  it('激活：社团及可选部门全部回读确认 → 已生效', async () => {
    const rig = makeRig();
    const inv = await rig.create.execute(createInput);
    await rig.accept.execute({
      routineInvitationId: inv.routineInvitationId,
      principalId: 'stu1',
      eligibilityOk: true,
      alreadyMember: false,
    });
    const result = await rig.resolve.execute({
      routineInvitationId: inv.routineInvitationId,
      escalateToAnomaly: false,
    });
    assert.equal(result.activated, true);
    assert.equal(result.invitation.status, 'ACTIVATED');
    assert.equal(result.invitation.syncStatus, 'ALL_CONFIRMED');
  });

  it('只确认部分关系不得成功 → 同步失败待重试（按组合补偿）', async () => {
    // 社团确认但部门未确认（部分确认）
    const rig = makeRig(
      makeCasdoor(async () => ({ groupConfirmed: true, departmentConfirmed: false })),
    );
    const inv = await rig.create.execute(createInput);
    await rig.accept.execute({
      routineInvitationId: inv.routineInvitationId,
      principalId: 'stu1',
      eligibilityOk: true,
      alreadyMember: false,
    });
    const result = await rig.resolve.execute({
      routineInvitationId: inv.routineInvitationId,
      escalateToAnomaly: false,
    });
    assert.equal(result.activated, false); // 不得成功
    assert.equal(result.invitation.status, 'SYNC_FAILED_PENDING_RETRY');
    assert.equal(result.invitation.syncStatus, 'PARTIAL');
  });

  it('外部失败（全未确认）→ 同步失败待重试（先回读后重试，无需本人重接）', async () => {
    const rig = makeRig(
      makeCasdoor(async () => ({ groupConfirmed: false, departmentConfirmed: false })),
    );
    const inv = await rig.create.execute(createInput);
    await rig.accept.execute({
      routineInvitationId: inv.routineInvitationId,
      principalId: 'stu1',
      eligibilityOk: true,
      alreadyMember: false,
    });
    const result = await rig.resolve.execute({
      routineInvitationId: inv.routineInvitationId,
      escalateToAnomaly: false,
    });
    assert.equal(result.activated, false);
    assert.equal(result.invitation.status, 'SYNC_FAILED_PENDING_RETRY');
    assert.equal(result.invitation.syncStatus, 'UNCONFIRMED');
  });

  it('无法确认且无法补偿到非成员 → 高优先级同步异常（冻结普通重试）', async () => {
    const rig = makeRig(
      makeCasdoor(async () => ({ groupConfirmed: false, departmentConfirmed: false })),
    );
    const inv = await rig.create.execute(createInput);
    await rig.accept.execute({
      routineInvitationId: inv.routineInvitationId,
      principalId: 'stu1',
      eligibilityOk: true,
      alreadyMember: false,
    });
    const result = await rig.resolve.execute({
      routineInvitationId: inv.routineInvitationId,
      escalateToAnomaly: true,
    });
    assert.equal(result.anomaly, true);
    assert.equal(result.invitation.status, 'HIGH_PRIORITY_SYNC_ANOMALY');
    assert.equal(result.invitation.syncStatus, 'ANOMALY');
    const view = await rig.status.getStatus(inv.routineInvitationId);
    assert.equal(view.activated, false); // 维持最小权限
  });

  it('拒绝/撤回/过期：仅待处理可操作；单胜者', async () => {
    const rig = makeRig();
    const inv1 = await rig.create.execute(createInput);
    const rejected = await rig.reject.execute({
      routineInvitationId: inv1.routineInvitationId,
      principalId: 'stu1',
    });
    assert.equal(rejected.status, 'REJECTED');
    const inv2 = await rig.create.execute({ ...createInput, inviteeId: 'stu2' });
    const withdrawn = await rig.withdraw.execute({
      routineInvitationId: inv2.routineInvitationId,
      principalId: 'hr1',
      principalRoles: ['HR_ADMIN'],
    });
    assert.equal(withdrawn.status, 'WITHDRAWN');
    const inv3 = await rig.create.execute({ ...createInput, inviteeId: 'stu3' });
    const expired = await rig.expire.execute({
      routineInvitationId: inv3.routineInvitationId,
      expiryAllowed: true,
    });
    assert.equal(expired!.status, 'EXPIRED');
    // 已接受不可撤回
    const inv4 = await rig.create.execute({ ...createInput, inviteeId: 'stu4' });
    await rig.accept.execute({
      routineInvitationId: inv4.routineInvitationId,
      principalId: 'stu4',
      eligibilityOk: true,
      alreadyMember: false,
    });
    await assert.rejects(
      rig.withdraw.execute({
        routineInvitationId: inv4.routineInvitationId,
        principalId: 'hr1',
        principalRoles: ['HR_ADMIN'],
      }),
      /仅待处理邀请可撤回/,
    );
  });

  it('重发：可重发状态（含目标已成为成员）重新校验全部约束，新对象旧保留', async () => {
    const rig = makeRig();
    const inv = await rig.create.execute(createInput);
    await rig.reject.execute({ routineInvitationId: inv.routineInvitationId, principalId: 'stu1' });
    const fresh = await rig.reissue.execute({
      oldInvitationId: inv.routineInvitationId,
      issuerId: 'hr1',
      issuerRoles: ['HR_ADMIN'],
      newExpiresAt: '2099-02-01T00:00:00.000Z',
      revalidated: { accountValid: true, notMemberYet: true, departmentValid: true },
    });
    assert.equal(fresh.status, 'PENDING');
    assert.notEqual(fresh.routineInvitationId, inv.routineInvitationId);
    // 旧邀请保留
    const old = await rig.repo.load(inv.routineInvitationId);
    assert.equal(old!.status, 'REJECTED');
    // 重发时目标已是成员 → 拒绝
    await assert.rejects(
      rig.reissue.execute({
        oldInvitationId: inv.routineInvitationId,
        issuerId: 'hr1',
        issuerRoles: ['HR_ADMIN'],
        newExpiresAt: '2099-02-01T00:00:00.000Z',
        revalidated: { accountValid: true, notMemberYet: false, departmentValid: true },
      }),
      /已是本社团成员/,
    );
  });

  it('重试仍失败：保持同步失败待重试（自环），不抛非法转换，attempt 累积', async () => {
    // 社团与部门持续未确认（全未确认，可重试）
    const rig = makeRig(
      makeCasdoor(async () => ({ groupConfirmed: false, departmentConfirmed: false })),
    );
    const inv = await rig.create.execute(createInput);
    await rig.accept.execute({
      routineInvitationId: inv.routineInvitationId,
      principalId: 'stu1',
      eligibilityOk: true,
      alreadyMember: false,
    });
    const first = await rig.resolve.execute({
      routineInvitationId: inv.routineInvitationId,
      escalateToAnomaly: false,
    });
    assert.equal(first.invitation.status, 'SYNC_FAILED_PENDING_RETRY');
    // 第二次重试仍失败：应保持重试状态而非抛 IllegalRoutineTransitionError
    const second = await rig.resolve.execute({
      routineInvitationId: inv.routineInvitationId,
      escalateToAnomaly: false,
    });
    assert.equal(second.invitation.status, 'SYNC_FAILED_PENDING_RETRY');
    assert.equal(second.activated, false);
    assert.equal(second.invitation.attemptCount, 2); // 重试次数累积
    // 不开放权限
    const view = await rig.status.getStatus(inv.routineInvitationId);
    assert.equal(view.activationPending, true);
    assert.equal(view.activated, false);
  });

  it('resolve 并发变更：CAS 失败抛 IFC-ERR-007（不覆盖版本更新）', async () => {
    // 组合回读期间，另一 worker 并发提交了更新的版本 → resolve 的 CAS 应失败
    let realId = '';
    const rig = makeRig(
      makeCasdoor(async () => {
        // 模拟并发：回读期间另一 worker 已提升同一邀请的版本并落库
        const latest = (await rig.repo.load(realId))!;
        await rig.repo.save({ ...latest, version: latest.version + 1 });
        return { groupConfirmed: true, departmentConfirmed: true };
      }),
    );
    const inv = await rig.create.execute(createInput);
    realId = inv.routineInvitationId;
    await rig.accept.execute({
      routineInvitationId: inv.routineInvitationId,
      principalId: 'stu1',
      eligibilityOk: true,
      alreadyMember: false,
    });
    await assert.rejects(
      rig.resolve.execute({
        routineInvitationId: inv.routineInvitationId,
        escalateToAnomaly: false,
      }),
      /IFC-ERR-007/,
    );
  });

  it('未指定初始部门时 group 未确认 → UNCONFIRMED（而非误标 PARTIAL）', async () => {
    const rig = makeRig(
      makeCasdoor(async () => ({ groupConfirmed: false, departmentConfirmed: true })),
    );
    // 不指定初始部门（initialDepartmentId = null）：仅 GROUP 一个组合目标
    const inv = await rig.create.execute({ ...createInput, initialDepartmentId: null });
    assert.equal(inv.relationTargets.length, 1);
    await rig.accept.execute({
      routineInvitationId: inv.routineInvitationId,
      principalId: 'stu1',
      eligibilityOk: true,
      alreadyMember: false,
    });
    const result = await rig.resolve.execute({
      routineInvitationId: inv.routineInvitationId,
      escalateToAnomaly: false,
    });
    assert.equal(result.activated, false);
    assert.equal(result.invitation.status, 'SYNC_FAILED_PENDING_RETRY');
    // 唯一目标未确认 → UNCONFIRMED，而非 PARTIAL
    assert.equal(result.invitation.syncStatus, 'UNCONFIRMED');
  });

  it('仓储幂等约束：并发重复保存 PENDING 时原子失败（消除 findPending+save 的 TOCTOU）', async () => {
    const rig = makeRig();
    const created = await rig.create.execute(createInput);
    // 模拟并发：跳过 findPending 预检，直接 save 一条同社团同对象、不同 id 的 PENDING
    // （等价于两个 worker 同时创建：一个已落库，另一个的 save 必须原子失败）
    const duplicate: RoutineInvitation = {
      routineInvitationId: 'race-dup',
      inviteeId: createInput.inviteeId,
      clubId: createInput.clubId,
      issuerId: createInput.issuerId,
      initialDepartmentId: createInput.initialDepartmentId,
      status: 'PENDING',
      version: 1,
      createdAt: '2099-01-01T00:00:00.000Z',
      expiresAt: createInput.expiresAt,
      acceptedAt: null,
      activatedAt: null,
      relationTargets: [],
      syncStatus: null,
      attemptCount: 0,
      history: [{ at: '2099-01-01T00:00:00.000Z', type: 'CREATED', by: createInput.issuerId }],
    };
    // 同社团同对象已存在 PENDING → 原子失败（即便 findPending 被绕过）
    await assert.rejects(rig.repo.save(duplicate), /IFC-ERR-009/);
    // 收口为已过期（非待处理）后不占用幂等槽位，可再发新待处理
    await rig.expire.execute({
      routineInvitationId: created.routineInvitationId,
      expiryAllowed: true,
    });
    const reissued = await rig.reissue.execute({
      oldInvitationId: created.routineInvitationId,
      issuerId: 'hr1',
      issuerRoles: ['HR_ADMIN'],
      newExpiresAt: '2099-02-01T00:00:00.000Z',
      revalidated: { accountValid: true, notMemberYet: true, departmentValid: true },
    });
    assert.equal(reissued.status, 'PENDING');
  });

  it('创建/重发并发竞争：同社团同对象已存在 PENDING 时抛 IFC-ERR-009 类型错误', async () => {
    const rig = makeRig();
    const inv = await rig.create.execute(createInput);
    // 同社团同对象已存在 PENDING（模拟并发创建方已抢先落库）→ create 抛类型错误
    await assert.rejects(rig.create.execute(createInput), (err: unknown) => {
      assert.ok(err instanceof CreateRoutineError);
      assert.match(err.message, /IFC-ERR-009/);
      return true;
    });
    // 原邀请先撤回为可重发状态
    await rig.withdraw.execute({
      routineInvitationId: inv.routineInvitationId,
      principalId: 'hr1',
      principalRoles: ['HR_ADMIN'],
    });
    // 同对象再并发创建一条 PENDING（占据幂等槽位）→ 重发 save 阶段原子失败转类型错误
    await rig.create.execute(createInput);
    await assert.rejects(
      rig.reissue.execute({
        oldInvitationId: inv.routineInvitationId,
        issuerId: 'hr1',
        issuerRoles: ['HR_ADMIN'],
        newExpiresAt: '2099-02-01T00:00:00.000Z',
        revalidated: { accountValid: true, notMemberYet: true, departmentValid: true },
      }),
      (err: unknown) => {
        assert.ok(err instanceof ReissueRoutineError);
        assert.match(err.message, /IFC-ERR-009/);
        return true;
      },
    );
  });
});
