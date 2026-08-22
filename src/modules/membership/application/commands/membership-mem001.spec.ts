import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { InMemoryMembershipRepository } from '../../infrastructure/membership-repository';
import type {
  GroupStepResult,
  MembershipCasdoorPort,
} from '../../infrastructure/casdoor-group.port';
import type { MembershipRelationTarget } from '../../domain/models/membership-period';
import {
  InMemoryMembershipAccessPort,
  InMemoryMembershipNotificationPort,
} from '../../infrastructure/in-memory-stubs';
import { EnterMembershipCommand } from './enter-membership.command';
import {
  ResolveMemberActivationCommand,
  ActivationBusyError,
} from './resolve-member-activation.command';
import {
  CompensateMemberActivationCommand,
  CompensationBusyError,
} from './compensate-member-activation.command';
import { RequestDepartureCommand } from './request-departure.command';
import { WithdrawDepartureCommand } from './withdraw-departure.command';
import { ApproveDepartureCommand } from './approve-departure.command';
import { RemoveMemberCommand } from './remove-member.command';
import { ExecuteDepartureCommand } from './execute-departure.command';
import { ReconcileExternalRemovalCommand } from './reconcile-external-removal.command';
import { MemberExperienceQuery } from '../queries/member-experience.query';
import { MembershipPeriodStateMachine } from '../../domain/state-machines/membership-period.state-machine';
import { MembershipPolicy } from '../../domain/services/membership-policy';
import { PlannedEndPolicy } from '../../domain/services/planned-end.policy';
import type { MembershipPeriod } from '../../domain/models/membership-period';

/** 测试用可编排 Casdoor 端口：按队列返回每步结果，记录幂等键与残留枚举 */
class StubCasdoorPort implements MembershipCasdoorPort {
  private readonly addOutcomes: GroupStepResult[][] = [];
  private readonly removeOutcomes: GroupStepResult[][] = [];
  private readonly intactQueue: boolean[];
  private readonly remainingQueue: MembershipRelationTarget[][];
  readonly removeKeys: string[] = [];
  constructor(
    addOutcomes: GroupStepResult[][] = [],
    removeOutcomes: GroupStepResult[][] = [],
    intact: boolean[] = [],
    remaining: MembershipRelationTarget[][] = [],
  ) {
    this.addOutcomes.push(...addOutcomes);
    this.removeOutcomes.push(...removeOutcomes);
    this.intactQueue = [...intact];
    this.remainingQueue = [...remaining];
  }
  async addAndReadBack(
    _clubId: string,
    _subjectId: string,
    targets: readonly MembershipRelationTarget[],
    _idempotencyKey: string,
  ): Promise<GroupStepResult[]> {
    const next = this.addOutcomes.shift();
    if (next !== undefined) return next;
    return targets.map((target) => ({ target, ok: true, confirmed: true }));
  }
  async removeAllAndReadBack(
    _clubId: string,
    _subjectId: string,
    targets: readonly MembershipRelationTarget[],
    idempotencyKey: string,
  ): Promise<GroupStepResult[]> {
    this.removeKeys.push(idempotencyKey);
    const next = this.removeOutcomes.shift();
    if (next !== undefined) return next;
    return targets.map((target) => ({ target, ok: true, confirmed: true }));
  }
  async confirmRelationsIntact(): Promise<boolean> {
    const next = this.intactQueue.shift();
    return next ?? true;
  }
  async listActiveRelationTargets(): Promise<MembershipRelationTarget[]> {
    const next = this.remainingQueue.shift();
    return next ?? [];
  }
}

const CLUB_TARGETS = [
  { kind: 'CLUB' as const, refId: 'c1' },
  { kind: 'DEPARTMENT' as const, refId: 'd1' },
];

const enterInput = {
  clubId: 'c1',
  subjectId: 'stu1',
  source: 'RECRUIT_OFFER' as const,
  entryRef: 'inv-1',
  businessEffectiveAt: '2026-01-01T10:00:00.000Z',
  targets: CLUB_TARGETS,
  eligibilityOk: true,
};

interface Rig {
  repo: InMemoryMembershipRepository;
  port: StubCasdoorPort;
  access: InMemoryMembershipAccessPort;
  notify: InMemoryMembershipNotificationPort;
  sm: MembershipPeriodStateMachine;
  plannedEnd: PlannedEndPolicy;
  enter: EnterMembershipCommand;
  resolveActivation: ResolveMemberActivationCommand;
  compensate: CompensateMemberActivationCommand;
  requestDeparture: RequestDepartureCommand;
  withdrawDeparture: WithdrawDepartureCommand;
  approveDeparture: ApproveDepartureCommand;
  removeMember: RemoveMemberCommand;
  executeDeparture: ExecuteDepartureCommand;
  reconcileExternal: ReconcileExternalRemovalCommand;
  query: MemberExperienceQuery;
}

const makeRig = (casdoor?: StubCasdoorPort): Rig => {
  const repo = new InMemoryMembershipRepository();
  const port = casdoor ?? new StubCasdoorPort();
  const access = new InMemoryMembershipAccessPort();
  const notify = new InMemoryMembershipNotificationPort();
  const policy = new MembershipPolicy();
  const sm = new MembershipPeriodStateMachine();
  const plannedEnd = new PlannedEndPolicy();
  const enter = new EnterMembershipCommand(repo, policy, notify, sm);
  const resolveActivation = new ResolveMemberActivationCommand(repo, port, notify, sm);
  const compensate = new CompensateMemberActivationCommand(repo, port, notify, sm);
  const requestDeparture = new RequestDepartureCommand(repo, policy, notify);
  const withdrawDeparture = new WithdrawDepartureCommand(repo);
  const approveDeparture = new ApproveDepartureCommand(repo, access, policy, notify);
  const removeMember = new RemoveMemberCommand(repo, access, policy, notify);
  const executeDeparture = new ExecuteDepartureCommand(repo, port, policy, access, notify, sm);
  const reconcileExternal = new ReconcileExternalRemovalCommand(repo, notify);
  const query = new MemberExperienceQuery(repo, plannedEnd);
  return {
    repo,
    port,
    access,
    notify,
    sm,
    plannedEnd,
    enter,
    resolveActivation,
    compensate,
    requestDeparture,
    withdrawDeparture,
    approveDeparture,
    removeMember,
    executeDeparture,
    reconcileExternal,
    query,
  };
};

/** 常用角色种子：stu1 为普通成员；hr1 人事；leader1 负责人；root 超管 */
function seedStandard(rig: Rig): void {
  rig.access.seedOwners('c1', ['leader1']);
  rig.access.seedOperator('c1', 'hr1', ['HR_ADMIN']);
  rig.access.seedOperator('c1', 'leader1', ['CLUB_LEADER']);
  rig.access.seedSuperAdmin('root');
}

/** 建立一段"当前成员"经历（已回读确认生效） */
async function makeCurrentMember(rig: Rig): Promise<MembershipPeriod> {
  const p = await rig.enter.execute(enterInput);
  const r = await rig.resolveActivation.execute({ periodId: p.periodId, deadlineExceeded: false });
  assert.equal(r.period.status, 'CURRENT_MEMBER');
  return r.period;
}

describe('5.2.1 成员经历 MEM-001 · 进入与生效处理中（转换 1）', () => {
  it('接受录取后进入成员生效处理中：业务生效时间=接受时间、记录组合写入目标、落通知事实', async () => {
    const rig = makeRig();
    const p = await rig.enter.execute(enterInput);
    assert.equal(p.status, 'ACTIVATION_PROCESSING');
    assert.equal(p.businessEffectiveAt, '2026-01-01T10:00:00.000Z');
    assert.equal(p.actualStartAt, null);
    assert.equal(p.activation?.phase, 'PENDING');
    assert.deepEqual(
      p.entryTargets.map((t) => t.kind + ':' + t.refId),
      ['CLUB:c1', 'DEPARTMENT:d1'],
    );
    assert.equal(p.history[0]?.type, 'ENTRY_STARTED');
    const facts = await rig.notify.list();
    assert.ok(facts.some((f) => f.kind === 'MEMBER_ENTRY_STARTED'));
  });

  it('同一接受/任命幂等：相同 entryRef 返回原经历段，不重复建段', async () => {
    const rig = makeRig();
    const p1 = await rig.enter.execute(enterInput);
    const p2 = await rig.enter.execute({ ...enterInput, source: 'REGULAR_INVITE' });
    assert.equal(p1.periodId, p2.periodId);
  });

  it('资格门未通过拒绝进入（IFC-ERR-006）；缺少社团 Group 拒绝（顺序不限）', async () => {
    const rig = makeRig();
    await assert.rejects(rig.enter.execute({ ...enterInput, eligibilityOk: false }), /IFC-ERR-006/);
    await assert.rejects(
      rig.enter.execute({ ...enterInput, targets: [{ kind: 'DEPARTMENT', refId: 'd1' }] }),
      /IFC-ERR-006/,
    );
    // 社团目标不在首位也可接受
    const ok = await rig.enter.execute({
      ...enterInput,
      entryRef: 'inv-order',
      targets: [
        { kind: 'DEPARTMENT', refId: 'd9' },
        { kind: 'CLUB', refId: 'c1' },
      ],
    });
    assert.equal(ok.status, 'ACTIVATION_PROCESSING');
  });

  it('社团＋用户当前成员唯一：已有当前成员时再进入拒绝（不同路径竞争只一个成功）', async () => {
    const rig = makeRig();
    await makeCurrentMember(rig);
    await assert.rejects(
      rig.enter.execute({ ...enterInput, entryRef: 'inv-other', source: 'JOINT_OFFER' }),
      /IFC-ERR-006/,
    );
  });

  it('处理中阻止重复或冲突操作（IFC-ERR-007）；并发进入唯一约束只一个成功（IFC-ERR-009）', async () => {
    const failing = new StubCasdoorPort([
      [
        { target: { kind: 'CLUB', refId: 'c1' }, ok: false, confirmed: false, reason: 'timeout' },
        {
          target: { kind: 'DEPARTMENT', refId: 'd1' },
          ok: false,
          confirmed: false,
          reason: 'timeout',
        },
      ],
    ]);
    const rig = makeRig(failing);
    await rig.enter.execute(enterInput);
    await assert.rejects(rig.enter.execute({ ...enterInput, entryRef: 'inv-2' }), /IFC-ERR-007/);

    // 并发进入（同社团同学生，两个不同 entryRef）：唯一约束保证只一个成功
    const rig2 = makeRig();
    const results = await Promise.allSettled([
      rig2.enter.execute({ ...enterInput, entryRef: 'race-a' }),
      rig2.enter.execute({ ...enterInput, entryRef: 'race-b' }),
    ]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    assert.equal(fulfilled.length, 1);
    assert.equal(rejected.length, 1);
  });

  it('历史成员重入必须新建经历段：旧段保持终态、新段独立（MEM-013）', async () => {
    const rig = makeRig();
    seedStandard(rig);
    const first = await makeCurrentMember(rig);
    await rig.requestDeparture.execute({
      periodId: first.periodId,
      requesterId: 'stu1',
      secondConfirmed: true,
    });
    const approved = await rig.approveDeparture.execute({
      periodId: first.periodId,
      approverId: 'hr1',
      action: 'approve',
      relationSnapshot: [],
    });
    assert.equal(approved.status, 'DEPARTURE_PROCESSING');
    const done = await rig.executeDeparture.execute({
      periodId: first.periodId,
      deadlineExceeded: false,
    });
    assert.equal(done.ended, true);
    const second = await rig.enter.execute({ ...enterInput, entryRef: 'inv-reentry' });
    assert.notEqual(second.periodId, first.periodId);
    assert.equal(second.status, 'ACTIVATION_PROCESSING');
    const timeline = await rig.query.listPeriods('c1', 'stu1');
    assert.equal(timeline.length, 2);
    assert.equal(timeline.find((v) => v.periodId === first.periodId)?.status, 'HISTORICAL_MEMBER');
  });
});

describe('5.2.1 成员经历 MEM-001 · 回读确认生效与失败重试（转换 2/3）', () => {
  it('全部目标写入并逐项回读确认 → 当前成员：原子记录实际开始、落生效通知', async () => {
    const rig = makeRig();
    const p = await rig.enter.execute(enterInput);
    const r = await rig.resolveActivation.execute({
      periodId: p.periodId,
      deadlineExceeded: false,
    });
    assert.equal(r.activated, true);
    assert.equal(r.period.status, 'CURRENT_MEMBER');
    assert.ok(r.period.actualStartAt !== null);
    assert.equal(r.period.activation?.phase, 'PENDING'); // 围栏释放
    assert.ok(r.period.history.some((h) => h.type === 'ACTIVATION_CONFIRMED'));
    const facts = await rig.notify.list();
    assert.ok(facts.some((f) => f.kind === 'MEMBER_ACTIVATED'));
  });

  it('仅写入响应成功但组合部门未全部确认 → 保持成员生效处理中，不得假成功', async () => {
    const partial = new StubCasdoorPort([
      [
        { target: { kind: 'CLUB', refId: 'c1' }, ok: true, confirmed: true },
        {
          target: { kind: 'DEPARTMENT', refId: 'd1' },
          ok: true,
          confirmed: false,
          reason: 'readback-miss',
        },
      ],
    ]);
    const rig = makeRig(partial);
    const p = await rig.enter.execute(enterInput);
    const r = await rig.resolveActivation.execute({
      periodId: p.periodId,
      deadlineExceeded: false,
    });
    assert.equal(r.activated, false);
    assert.equal(r.period.status, 'ACTIVATION_PROCESSING');
    assert.equal(r.period.actualStartAt, null);
  });

  it('15 分钟内失败：保持处理中＋尝试痕迹；最小权限不开放（转换 3）', async () => {
    const failing = new StubCasdoorPort([
      [
        {
          target: { kind: 'CLUB', refId: 'c1' },
          ok: false,
          confirmed: false,
          reason: 'casdoor-5xx',
        },
      ],
    ]);
    const rig = makeRig(failing);
    const p = await rig.enter.execute(enterInput);
    const r = await rig.resolveActivation.execute({
      periodId: p.periodId,
      deadlineExceeded: false,
    });
    assert.equal(r.activated, false);
    assert.equal(r.period.status, 'ACTIVATION_PROCESSING');
    assert.equal(r.period.activation?.attemptCount, 1);
    assert.match(r.period.activation?.lastError ?? '', /casdoor-5xx/);
  });

  it('15 分钟仍失败 → 失败/重试标志：保持处理中、接受事实不回滚，先回读后重试', async () => {
    const failing = new StubCasdoorPort([
      [
        {
          target: { kind: 'CLUB', refId: 'c1' },
          ok: false,
          confirmed: false,
          reason: 'unknown-outcome',
        },
      ],
      [
        {
          target: { kind: 'CLUB', refId: 'c1' },
          ok: false,
          confirmed: false,
          reason: 'still-down',
        },
      ],
    ]);
    const rig = makeRig(failing);
    const p = await rig.enter.execute(enterInput);
    await rig.resolveActivation.execute({ periodId: p.periodId, deadlineExceeded: true });
    const r2 = await rig.resolveActivation.execute({
      periodId: p.periodId,
      deadlineExceeded: false,
    });
    assert.equal(r2.period.status, 'ACTIVATION_PROCESSING');
    assert.equal(r2.period.activation?.progress, 'FAILED_PENDING_RETRY');
    assert.match(r2.period.activation?.lastError ?? '', /still-down/);
  });

  it('已生效重复回调幂等收敛返回已生效；不重复追加确认历史（ORG-027）', async () => {
    const rig = makeRig();
    const current = await makeCurrentMember(rig);
    const again = await rig.resolveActivation.execute({
      periodId: current.periodId,
      deadlineExceeded: false,
    });
    assert.equal(again.activated, true);
    assert.equal(again.period.status, 'CURRENT_MEMBER');
    const view = await rig.query.currentPeriod('c1', 'stu1');
    assert.equal(view?.history.filter((h) => h.type === 'ACTIVATION_CONFIRMED').length, 1);
  });

  it('方向围栏：补偿在途时激活解析被拒（IFC-ERR-007）；同向重入允许', async () => {
    const rig = makeRig();
    const p = await rig.enter.execute(enterInput);
    // 手工占用 COMPENSATING 相位模拟补偿在途
    const fenced = {
      ...p,
      version: p.version + 1,
      activation: { ...p.activation!, phase: 'COMPENSATING' as const },
    };
    await rig.repo.compareAndSwap(p, fenced);
    await assert.rejects(
      rig.resolveActivation.execute({ periodId: p.periodId, deadlineExceeded: false }),
      (e: unknown) => e instanceof ActivationBusyError,
    );
  });
});

describe('5.2.1 成员经历 MEM-001 · 组合写入部分成功的补偿（转换 4）', () => {
  it('补偿全部确认 → 草稿作废回非成员：接受事实经历史保留，可重新进入，落通知', async () => {
    const rig = makeRig();
    const p = await rig.enter.execute(enterInput);
    const r = await rig.compensate.execute({ periodId: p.periodId });
    assert.equal(r.compensated, true);
    assert.equal(r.period.status, 'ENTRY_COMPENSATED');
    assert.ok(r.period.history.some((h) => h.type === 'ENTRY_STARTED'));
    assert.ok(r.period.history.some((h) => h.type === 'ENTRY_COMPENSATED'));
    const facts = await rig.notify.list();
    assert.ok(facts.some((f) => f.kind === 'MEMBER_ENTRY_COMPENSATED'));
    const again = await rig.enter.execute({ ...enterInput, entryRef: 'inv-2' });
    assert.notEqual(again.periodId, p.periodId);
  });

  it('补偿未确认 → 保持处理中，不得转非成员（高优先级异常由调用方触发）', async () => {
    const stuck = new StubCasdoorPort(
      [],
      [
        [
          { target: { kind: 'CLUB', refId: 'c1' }, ok: true, confirmed: true },
          {
            target: { kind: 'DEPARTMENT', refId: 'd1' },
            ok: true,
            confirmed: false,
            reason: 'compensate-readback-miss',
          },
        ],
      ],
    );
    const rig = makeRig(stuck);
    const p = await rig.enter.execute(enterInput);
    const r = await rig.compensate.execute({ periodId: p.periodId });
    assert.equal(r.compensated, false);
    assert.equal(r.period.status, 'ACTIVATION_PROCESSING');
  });

  it('已回读确认生效的经历不得补偿为非成员；已补偿收口重复任务幂等返回', async () => {
    const rig = makeRig();
    const current = await makeCurrentMember(rig);
    await assert.rejects(rig.compensate.execute({ periodId: current.periodId }), /IFC-ERR-006/);

    const rig2 = makeRig();
    const p2 = await rig2.enter.execute(enterInput);
    await rig2.compensate.execute({ periodId: p2.periodId });
    const repeat = await rig2.compensate.execute({ periodId: p2.periodId });
    assert.equal(repeat.compensated, true);
    assert.equal(repeat.period.history.filter((h) => h.type === 'ENTRY_COMPENSATED').length, 1);
  });

  it('方向围栏：激活写入在途时补偿被拒（IFC-ERR-007）', async () => {
    const rig = makeRig();
    const p = await rig.enter.execute(enterInput);
    const fenced = {
      ...p,
      version: p.version + 1,
      activation: { ...p.activation!, phase: 'WRITING' as const },
    };
    await rig.repo.compareAndSwap(p, fenced);
    await assert.rejects(
      rig.compensate.execute({ periodId: p.periodId }),
      (e: unknown) => e instanceof CompensationBusyError,
    );
  });
});

describe('5.2.1 成员经历 MEM-001 · 主动退出申请与审批（转换 5，MEM-002/005）', () => {
  it('提交退出必须本人＋二次确认；非本人/未二次确认拒绝', async () => {
    const rig = makeRig();
    const current = await makeCurrentMember(rig);
    await assert.rejects(
      rig.requestDeparture.execute({
        periodId: current.periodId,
        requesterId: 'other',
        secondConfirmed: true,
      }),
      /IFC-ERR-003/,
    );
    await assert.rejects(
      rig.requestDeparture.execute({
        periodId: current.periodId,
        requesterId: 'stu1',
        secondConfirmed: false,
      }),
      /IFC-ERR-006/,
    );
  });

  it('审批角色服务端重算：人事可批；部门负责人无权；自审拒绝（MEM-005、ORG-038）', async () => {
    const rig = makeRig();
    seedStandard(rig);
    const current = await makeCurrentMember(rig);
    await rig.requestDeparture.execute({
      periodId: current.periodId,
      requesterId: 'stu1',
      secondConfirmed: true,
    });
    // 部门负责人：端口重算后无权
    rig.access.seedOperator('c1', 'dept1', ['DEPARTMENT_LEADER']);
    await assert.rejects(
      rig.approveDeparture.execute({
        periodId: current.periodId,
        approverId: 'dept1',
        action: 'approve',
        relationSnapshot: [],
      }),
      /IFC-ERR-003/,
    );
    // 自审拒绝
    await assert.rejects(
      rig.approveDeparture.execute({
        periodId: current.periodId,
        approverId: 'stu1',
        action: 'approve',
        relationSnapshot: [],
      }),
      /IFC-ERR-003/,
    );
    const approved = await rig.approveDeparture.execute({
      periodId: current.periodId,
      approverId: 'hr1',
      action: 'approve',
      relationSnapshot: [{ kind: 'DEPARTMENT', refId: 'd1' }],
    });
    assert.equal(approved.status, 'DEPARTURE_PROCESSING');
    assert.deepEqual(
      approved.departure?.snapshot.map((t) => t.refId),
      ['d1'],
    );
    const facts = await rig.notify.list();
    assert.ok(facts.some((f) => f.kind === 'MEMBER_DEPARTURE_APPROVED'));
  });

  it('驳回必须填写原因；驳回后保持当前成员并留痕＋通知（MEM-005）', async () => {
    const rig = makeRig();
    seedStandard(rig);
    const current = await makeCurrentMember(rig);
    await rig.requestDeparture.execute({
      periodId: current.periodId,
      requesterId: 'stu1',
      secondConfirmed: true,
    });
    await assert.rejects(
      rig.approveDeparture.execute({
        periodId: current.periodId,
        approverId: 'hr1',
        action: 'reject',
        rejectionReason: ' ',
        relationSnapshot: [],
      }),
      /IFC-ERR-006/,
    );
    const rejected = await rig.approveDeparture.execute({
      periodId: current.periodId,
      approverId: 'hr1',
      action: 'reject',
      rejectionReason: '换届前暂缓',
      relationSnapshot: [],
    });
    assert.equal(rejected.status, 'CURRENT_MEMBER');
    assert.equal(rejected.departure?.requestStatus, 'REJECTED');
    assert.equal(rejected.departure?.rejectionReason, '换届前暂缓');
    const facts = await rig.notify.list();
    assert.ok(
      facts.some((f) => f.kind === 'MEMBER_DEPARTURE_REJECTED' && f.body.includes('换届前暂缓')),
    );
  });

  it('撤回与审批并发只一个成功：撤回后审批被拒；批准后不可再撤回（MEM-005）', async () => {
    const rig = makeRig();
    seedStandard(rig);
    const current = await makeCurrentMember(rig);
    await rig.requestDeparture.execute({
      periodId: current.periodId,
      requesterId: 'stu1',
      secondConfirmed: true,
    });
    await rig.withdrawDeparture.execute({ periodId: current.periodId, requesterId: 'stu1' });
    await assert.rejects(
      rig.approveDeparture.execute({
        periodId: current.periodId,
        approverId: 'hr1',
        action: 'approve',
        relationSnapshot: [],
      }),
      /IFC-ERR-007/,
    );

    // 批准后不可再撤回
    const rig2 = makeRig();
    seedStandard(rig2);
    const current2 = await makeCurrentMember(rig2);
    await rig2.requestDeparture.execute({
      periodId: current2.periodId,
      requesterId: 'stu1',
      secondConfirmed: true,
    });
    await rig2.approveDeparture.execute({
      periodId: current2.periodId,
      approverId: 'hr1',
      action: 'approve',
      relationSnapshot: [],
      successorOwnerIds: ['next'],
    });
    await assert.rejects(
      rig2.withdrawDeparture.execute({ periodId: current2.periodId, requesterId: 'stu1' }),
      /IFC-ERR-007/,
    );
  });

  it('在案决定未收口时不得新建申请覆盖工作态（F6）：先人工重试完成级联', async () => {
    const rig = makeRig();
    seedStandard(rig);
    const current = await makeCurrentMember(rig);
    await rig.requestDeparture.execute({
      periodId: current.periodId,
      requesterId: 'stu1',
      secondConfirmed: true,
    });
    await rig.approveDeparture.execute({
      periodId: current.periodId,
      approverId: 'hr1',
      action: 'approve',
      relationSnapshot: [],
      successorOwnerIds: ['next'],
    });
    // 当前成员？否——已进入退出处理中，直接拒绝新申请
    await assert.rejects(
      rig.requestDeparture.execute({
        periodId: current.periodId,
        requesterId: 'stu1',
        secondConfirmed: true,
      }),
      /IFC-ERR-006/,
    );
  });

  it('最后一名负责人退出：无交接拒绝；指定继任者同操作通过（ORG-024/MEM-002）', async () => {
    const rig = makeRig();
    seedStandard(rig);
    rig.access.seedSubjectRole('c1', 'stu1', 'CLUB_LEADER'); // 被审批人主角色=负责人
    rig.access.seedOwners('c1', ['stu1']); // 唯一负责人
    const leader = await makeCurrentMember(rig);
    await rig.requestDeparture.execute({
      periodId: leader.periodId,
      requesterId: 'stu1',
      secondConfirmed: true,
    });
    await assert.rejects(
      rig.approveDeparture.execute({
        periodId: leader.periodId,
        approverId: 'hr1',
        action: 'approve',
        relationSnapshot: [],
      }),
      /ORG-024/,
    );
    const withSuccessor = await rig.approveDeparture.execute({
      periodId: leader.periodId,
      approverId: 'hr1',
      action: 'approve',
      successorOwnerIds: ['new-owner'],
      relationSnapshot: [],
    });
    assert.equal(withSuccessor.status, 'DEPARTURE_PROCESSING');
  });

  it('超管紧急处置豁免仅限最后负责人僵局；非僵局启用被拒；非超管被拒（ORG-024/F3）', async () => {
    // 僵局场景：唯一负责人退出，无继任者 → 允许超管豁免
    const rigA = makeRig();
    seedStandard(rigA);
    rigA.access.seedSubjectRole('c1', 'stu1', 'CLUB_LEADER');
    rigA.access.seedOwners('c1', ['stu1']);
    const a = await makeCurrentMember(rigA);
    await rigA.requestDeparture.execute({
      periodId: a.periodId,
      requesterId: 'stu1',
      secondConfirmed: true,
    });
    const emergency = await rigA.approveDeparture.execute({
      periodId: a.periodId,
      approverId: 'root',
      action: 'approve',
      emergencyBypass: true,
      relationSnapshot: [],
    });
    assert.equal(emergency.status, 'DEPARTURE_PROCESSING');

    // 非僵局：仍有其他负责人 → 置豁免被拒（不得绕过常规审批）
    const rigB = makeRig();
    seedStandard(rigB);
    rigB.access.seedSubjectRole('c1', 'stu1', 'CLUB_LEADER');
    rigB.access.seedOwners('c1', ['stu1', 'leader1']);
    const b = await makeCurrentMember(rigB);
    await rigB.requestDeparture.execute({
      periodId: b.periodId,
      requesterId: 'stu1',
      secondConfirmed: true,
    });
    await assert.rejects(
      rigB.approveDeparture.execute({
        periodId: b.periodId,
        approverId: 'root',
        action: 'approve',
        emergencyBypass: true,
        relationSnapshot: [],
      }),
      /IFC-ERR-006/,
    );
    // 非超管置豁免同样被拒（僵局但操作者不是超管）
    rigB.access.seedOwners('c1', ['stu1']);
    const b2rig = makeRig();
    seedStandard(b2rig);
    b2rig.access.seedSubjectRole('c1', 'stu1', 'CLUB_LEADER');
    b2rig.access.seedOwners('c1', ['stu1']);
    const b2 = await makeCurrentMember(b2rig);
    await b2rig.requestDeparture.execute({
      periodId: b2.periodId,
      requesterId: 'stu1',
      secondConfirmed: true,
    });
    await assert.rejects(
      b2rig.approveDeparture.execute({
        periodId: b2.periodId,
        approverId: 'hr1',
        action: 'approve',
        emergencyBypass: true,
        relationSnapshot: [],
      }),
      /IFC-ERR-003/,
    );
  });
});

describe('5.2.1 成员经历 MEM-001 · 管理员移除（转换 5，MEM-008、ORG-038）', () => {
  const removalBase = {
    operatorId: 'leader1',
    reason: '违反社团章程',
    secondConfirmed: true,
    relationSnapshot: [],
  };

  it('负责人移除普通成员：受理即退出处理中，原因与快照留痕＋通知', async () => {
    const rig = makeRig();
    seedStandard(rig);
    const current = await makeCurrentMember(rig);
    const removed = await rig.removeMember.execute({ ...removalBase, periodId: current.periodId });
    assert.equal(removed.status, 'DEPARTURE_PROCESSING');
    assert.equal(removed.departure?.kind, 'REMOVAL');
    assert.equal(removed.departure?.requestStatus, 'APPROVED');
    assert.ok(removed.history.some((h) => h.type === 'REMOVAL_DECIDED'));
    const facts = await rig.notify.list();
    assert.ok(facts.some((f) => f.kind === 'MEMBER_REMOVAL_DECIDED'));
  });

  it('层级门控（服务端重算）：人事不能移除人事；无权操作者被拒；自我移除拒绝', async () => {
    const rig = makeRig();
    seedStandard(rig);
    // 目标是人事：仅社团负责人可移除（hr1 操作被拒）
    rig.access.seedSubjectRole('c1', 'stu1', 'HR_ADMIN');
    const hrTarget = await makeCurrentMember(rig);
    await assert.rejects(
      rig.removeMember.execute({ ...removalBase, periodId: hrTarget.periodId, operatorId: 'hr1' }),
      /IFC-ERR-003/,
    );
    const byLeader = await rig.removeMember.execute({
      ...removalBase,
      periodId: hrTarget.periodId,
    });
    assert.equal(byLeader.status, 'DEPARTURE_PROCESSING');

    // 无管理角色者移除被拒
    const rig2 = makeRig();
    seedStandard(rig2);
    const plainTarget = await makeCurrentMember(rig2);
    await assert.rejects(
      rig2.removeMember.execute({
        ...removalBase,
        periodId: plainTarget.periodId,
        operatorId: 'stu2',
      }),
      /IFC-ERR-003/,
    );

    // 自我移除拒绝（MEM-008）
    const rig3 = makeRig();
    seedStandard(rig3);
    rig3.access.seedOperator('c1', 'stu1', ['CLUB_LEADER']);
    const selfTarget = await makeCurrentMember(rig3);
    await assert.rejects(
      rig3.removeMember.execute({
        ...removalBase,
        periodId: selfTarget.periodId,
        operatorId: 'stu1',
      }),
      /IFC-ERR-003/,
    );
  });

  it('缺少原因或未二次确认拒绝（MEM-008）', async () => {
    const rig = makeRig();
    seedStandard(rig);
    const current = await makeCurrentMember(rig);
    await assert.rejects(
      rig.removeMember.execute({ ...removalBase, periodId: current.periodId, reason: '' }),
      /IFC-ERR-006/,
    );
    await assert.rejects(
      rig.removeMember.execute({
        ...removalBase,
        periodId: current.periodId,
        secondConfirmed: false,
      }),
      /IFC-ERR-006/,
    );
  });

  it('移除最后一名负责人必须先交接；超管紧急处置仅限僵局（ORG-024/MEM-008/F3）', async () => {
    const rig = makeRig();
    seedStandard(rig);
    rig.access.seedSubjectRole('c1', 'stu1', 'CLUB_LEADER');
    rig.access.seedOwners('c1', ['stu1']); // 唯一负责人，名单遗漏兜底生效
    const leader = await makeCurrentMember(rig);
    await assert.rejects(
      rig.removeMember.execute({ ...removalBase, periodId: leader.periodId }),
      /ORG-024/,
    );
    // 非僵局时置豁免被拒：另一名负责人在任（独立 rig，避免污染僵局场景）
    const rigB = makeRig();
    seedStandard(rigB);
    rigB.access.seedSubjectRole('c1', 'stu1', 'CLUB_LEADER');
    rigB.access.seedOwners('c1', ['stu1', 'other-leader']);
    const leaderB = await makeCurrentMember(rigB);
    await assert.rejects(
      rigB.removeMember.execute({
        ...removalBase,
        periodId: leaderB.periodId,
        operatorId: 'root',
        emergencyBypass: true,
      }),
      /IFC-ERR-006/,
    );
    // 僵局 + 超管豁免 → 通过
    const withBypass = await rig.removeMember.execute({
      ...removalBase,
      periodId: leader.periodId,
      operatorId: 'root',
      emergencyBypass: true,
    });
    assert.equal(withBypass.status, 'DEPARTURE_PROCESSING');
  });

  it('前次驳回的决定在新移除受理时结构化归档（F5），不丢失审批痕迹', async () => {
    const rig = makeRig();
    seedStandard(rig);
    const current = await makeCurrentMember(rig);
    await rig.requestDeparture.execute({
      periodId: current.periodId,
      requesterId: 'stu1',
      secondConfirmed: true,
    });
    await rig.approveDeparture.execute({
      periodId: current.periodId,
      approverId: 'hr1',
      action: 'reject',
      rejectionReason: '暂缓',
      relationSnapshot: [],
    });
    const removed = await rig.removeMember.execute({ ...removalBase, periodId: current.periodId });
    assert.equal(removed.departure?.priorDecisions.length, 1);
    assert.equal(removed.departure?.priorDecisions[0]?.requestStatus, 'REJECTED');
    assert.equal(removed.departure?.priorDecisions[0]?.rejectionReason, '暂缓');
    assert.equal(removed.departure?.priorDecisions[0]?.decidedBy, 'hr1');
  });
});

describe('5.2.1 成员经历 MEM-001 · 退出执行与失败恢复（转换 6/7）', () => {
  async function approvedDeparture(rig: Rig): Promise<MembershipPeriod> {
    seedStandard(rig);
    const current = await makeCurrentMember(rig);
    await rig.requestDeparture.execute({
      periodId: current.periodId,
      requesterId: 'stu1',
      reason: '学业繁忙',
      secondConfirmed: true,
    });
    return rig.approveDeparture.execute({
      periodId: current.periodId,
      approverId: 'hr1',
      action: 'approve',
      relationSnapshot: [{ kind: 'DEPARTMENT', refId: 'd1' }],
    });
  }

  it('全部 Group 移除并回读确认 → 历史成员：实际结束落笔、只结束一次、落完成通知', async () => {
    const rig = makeRig();
    const departing = await approvedDeparture(rig);
    const done = await rig.executeDeparture.execute({
      periodId: departing.periodId,
      deadlineExceeded: false,
    });
    assert.equal(done.ended, true);
    assert.equal(done.period.status, 'HISTORICAL_MEMBER');
    assert.ok(done.period.actualEndAt !== null);
    assert.equal(done.period.departure?.execution, 'COMPLETED');
    const again = await rig.executeDeparture.execute({
      periodId: departing.periodId,
      deadlineExceeded: false,
    });
    assert.equal(again.ended, true);
    assert.equal(again.period.history.filter((h) => h.type === 'PERIOD_ENDED').length, 1);
    const facts = await rig.notify.list();
    assert.ok(facts.some((f) => f.kind === 'MEMBER_DEPARTURE_COMPLETED'));
  });

  it('级联范围=社团＋快照全部关系；幂等键按经历段固定（人工重试不换键）', async () => {
    const rig = makeRig();
    const departing = await approvedDeparture(rig);
    await rig.executeDeparture.execute({ periodId: departing.periodId, deadlineExceeded: false });
    assert.deepEqual(rig.port.removeKeys, ['member-depart:' + departing.periodId]);
  });

  it('快照遗漏的残留关系不得静默放过：收口前全量自查保持处理中并标异常（F2/ORG-030）', async () => {
    // 移除步骤全部成功，但回读枚举发现快照外的残留职位 Group
    const leftover = new StubCasdoorPort([], [], [], [[{ kind: 'POSITION', refId: 'p-hidden' }]]);
    const rig = makeRig(leftover);
    const departing = await approvedDeparture(rig);
    const r = await rig.executeDeparture.execute({
      periodId: departing.periodId,
      deadlineExceeded: false,
    });
    assert.equal(r.ended, false);
    assert.equal(r.period.status, 'DEPARTURE_PROCESSING');
    assert.equal(r.period.hasResidualAnomaly, true);
    assert.match(r.period.departure?.lastError ?? '', /p-hidden/);
  });

  it('任一目标未确认移除 → 保持退出处理中继续重试，不得假成功（转换 6 保持分支）', async () => {
    const partialRemove = new StubCasdoorPort(
      [],
      [
        [
          { target: { kind: 'CLUB', refId: 'c1' }, ok: true, confirmed: true },
          {
            target: { kind: 'DEPARTMENT', refId: 'd1' },
            ok: false,
            confirmed: false,
            reason: 'dept-remove-failed',
          },
        ],
      ],
    );
    const rig = makeRig(partialRemove);
    const departing = await approvedDeparture(rig);
    const r = await rig.executeDeparture.execute({
      periodId: departing.periodId,
      deadlineExceeded: false,
    });
    assert.equal(r.ended, false);
    assert.equal(r.period.status, 'DEPARTURE_PROCESSING');
    assert.match(r.period.departure?.lastError ?? '', /dept-remove-failed/);
  });

  it('15 分钟后失败收口且原关系完整 → 恢复当前成员；决定保留；恢复后自动任务被拒（转换 7）', async () => {
    const failingThenIntact = new StubCasdoorPort(
      [],
      [
        [
          {
            target: { kind: 'CLUB', refId: 'c1' },
            ok: false,
            confirmed: false,
            reason: 'gateway-timeout',
          },
        ],
      ],
      [true],
    );
    const rig = makeRig(failingThenIntact);
    const departing = await approvedDeparture(rig);
    const r = await rig.executeDeparture.execute({
      periodId: departing.periodId,
      deadlineExceeded: true,
    });
    assert.equal(r.restoredToCurrent, true);
    assert.equal(r.period.status, 'CURRENT_MEMBER');
    assert.equal(r.period.departure?.execution, 'FAILED_RESTORED');
    assert.ok(r.period.departure?.decidedBy === 'hr1');
    assert.ok(r.period.history.some((h) => h.type === 'EXIT_EXECUTION_FAILED_RESTORED'));
    const facts = await rig.notify.list();
    assert.ok(facts.some((f) => f.kind === 'MEMBER_DEPARTURE_EXECUTION_FAILED'));

    // 恢复后系统任务（无 manualRetry）不可自行续跑：必须人工重试重新鉴权
    await assert.rejects(
      rig.executeDeparture.execute({ periodId: departing.periodId, deadlineExceeded: false }),
      /ORG-027/,
    );
  });

  it('无法确认原关系完整时不得恢复当前成员，保持处理中/同步异常', async () => {
    const failingNotIntact = new StubCasdoorPort(
      [],
      [[{ target: { kind: 'CLUB', refId: 'c1' }, ok: false, confirmed: false, reason: 'unknown' }]],
      [false],
    );
    const rig = makeRig(failingNotIntact);
    const departing = await approvedDeparture(rig);
    const r = await rig.executeDeparture.execute({
      periodId: departing.periodId,
      deadlineExceeded: true,
    });
    assert.equal(r.restoredToCurrent, false);
    assert.equal(r.period.status, 'DEPARTURE_PROCESSING');
  });

  it('人工重试重新鉴权（服务端重算角色）：无权拒绝；有权从恢复态走转换5边继续到历史成员', async () => {
    const failingThenIntact = new StubCasdoorPort(
      [],
      [
        [
          {
            target: { kind: 'CLUB', refId: 'c1' },
            ok: false,
            confirmed: false,
            reason: 'gateway-timeout',
          },
        ],
      ],
      [true],
    );
    const rig = makeRig(failingThenIntact);
    const departing = await approvedDeparture(rig);
    const restored = await rig.executeDeparture.execute({
      periodId: departing.periodId,
      deadlineExceeded: true,
    });
    assert.equal(restored.restoredToCurrent, true);
    // 无权者人工重试被拒
    await assert.rejects(
      rig.executeDeparture.execute({
        periodId: departing.periodId,
        deadlineExceeded: false,
        manualRetry: true,
        actorId: 'stu2',
      }),
      /IFC-ERR-003/,
    );
    // 有权（hr）重试：CURRENT→DEPARTURE_PROCESSING→HISTORICAL_MEMBER 全程合法
    const retried = await rig.executeDeparture.execute({
      periodId: departing.periodId,
      deadlineExceeded: false,
      manualRetry: true,
      actorId: 'hr1',
    });
    assert.equal(retried.ended, true);
    assert.equal(retried.period.status, 'HISTORICAL_MEMBER');
    for (const k of rig.port.removeKeys) {
      assert.equal(k, 'member-depart:' + departing.periodId);
    }
  });
});

describe('5.2.1 成员经历 MEM-001 · Casdoor 外部直接移除对账（转换 8，ORG-026/030、MEM-016）', () => {
  it('可信确认外部移除 → 立即历史成员：撤销访问、追加外部变更历史＋通知', async () => {
    const rig = makeRig();
    const current = await makeCurrentMember(rig);
    const r = await rig.reconcileExternal.execute({
      periodId: current.periodId,
      trustedConfirmed: true,
      upstreamAt: '2026-01-02T08:00:00.000Z',
    });
    assert.equal(r.ended, true);
    assert.equal(r.period.status, 'HISTORICAL_MEMBER');
    assert.equal(r.period.hasResidualAnomaly, false);
    const ext = r.period.history.find((h) => h.type === 'EXTERNAL_CHANGE');
    assert.ok(ext);
    assert.equal(ext?.upstreamAt, '2026-01-02T08:00:00.000Z');
    const facts = await rig.notify.list();
    assert.ok(facts.some((f) => f.kind === 'MEMBER_EXTERNAL_REMOVAL'));
  });

  it('无可靠上游时间：用检测时间并标记原始生效时间未知（MEM-016）', async () => {
    const rig = makeRig();
    const current = await makeCurrentMember(rig);
    const r = await rig.reconcileExternal.execute({
      periodId: current.periodId,
      trustedConfirmed: true,
    });
    const ext = r.period.history.find((h) => h.type === 'EXTERNAL_CHANGE');
    assert.ok(ext);
    assert.equal(ext?.upstreamAt, undefined);
    assert.match(ext?.note ?? '', /原始生效时间未知/);
  });

  it('残留子级关系：标记异常且不自动删除（记录保留等待人工处理，ORG-030）', async () => {
    const rig = makeRig();
    const current = await makeCurrentMember(rig);
    const r = await rig.reconcileExternal.execute({
      periodId: current.periodId,
      trustedConfirmed: true,
      residualTargets: [
        { kind: 'DEPARTMENT', refId: 'd1' },
        { kind: 'POSITION', refId: 'p1' },
      ],
    });
    assert.equal(r.ended, true);
    assert.equal(r.period.hasResidualAnomaly, true);
    const ext = r.period.history.find((h) => h.type === 'EXTERNAL_CHANGE');
    assert.deepEqual(
      ext?.residualTargets?.map((t) => t.kind + ':' + t.refId),
      ['DEPARTMENT:d1', 'POSITION:p1'],
    );
    assert.match(ext?.note ?? '', /不自动删除/);
  });

  it('状态无法可信确认 → 不结束经历：保持当前成员并进入对账异常', async () => {
    const rig = makeRig();
    const current = await makeCurrentMember(rig);
    const r = await rig.reconcileExternal.execute({
      periodId: current.periodId,
      trustedConfirmed: false,
    });
    assert.equal(r.ended, false);
    assert.equal(r.reconciliationAnomaly, true);
    assert.equal(r.period.status, 'CURRENT_MEMBER');
  });

  it('仅当前成员可按转换 8 收口：处理中草稿/退出处理中不得借外部移除越径结束', async () => {
    const rig = makeRig();
    const draft = await rig.enter.execute(enterInput);
    await assert.rejects(
      rig.reconcileExternal.execute({ periodId: draft.periodId, trustedConfirmed: true }),
      /IFC-ERR-006/,
    );
    assert.equal(draft.status, 'ACTIVATION_PROCESSING');
  });

  it('外部事件幂等：重复收口不追加重复历史', async () => {
    const rig = makeRig();
    const current = await makeCurrentMember(rig);
    await rig.reconcileExternal.execute({ periodId: current.periodId, trustedConfirmed: true });
    const again = await rig.reconcileExternal.execute({
      periodId: current.periodId,
      trustedConfirmed: true,
    });
    assert.equal(again.ended, true);
    assert.equal(again.period.history.filter((h) => h.type === 'EXTERNAL_CHANGE').length, 1);
  });
});

describe('5.2.1 成员经历 MEM-001 · 计划结束不自动卸任（MEM-010/012/014、CFG-003）', () => {
  it('计划时间已过但无实际卸任事件：仍为当前成员，展示在任、永不显示逾期', async () => {
    const rig = makeRig();
    const p = await rig.enter.execute({ ...enterInput, plannedEndAt: '2026-01-15T00:00:00.000Z' });
    await rig.resolveActivation.execute({ periodId: p.periodId, deadlineExceeded: false });
    const view = await rig.query.currentPeriod('c1', 'stu1');
    assert.equal(view?.status, 'CURRENT_MEMBER');
    assert.ok(view?.plannedEndAt !== null);
    assert.equal(Date.parse(view!.plannedEndAt!) < Date.now(), true);
    assert.equal(view?.inOffice, true, '计划时间已过仍应在任（MEM-012）');
    assert.equal(view?.overdue, false, '前台不得展示逾期/到期（MEM-014）');
  });

  it('仅因计划时间到达的自动卸任尝试被策略拒绝（IFC-ERR-007 状态冲突）', () => {
    const policy = new PlannedEndPolicy();
    assert.throws(
      () =>
        policy.assertNoAutoEndAtPlannedEnd(
          '2026-01-01T00:00:00.000Z',
          new Date('2026-02-01T00:00:00.000Z'),
        ),
      /IFC-ERR-007/,
    );
    policy.assertNoAutoEndAtPlannedEnd('2099-01-01T00:00:00.000Z', new Date());
  });

  it('状态机无时间驱动出边；终态不可复活；仓储 CAS 拒绝终态换入', async () => {
    const sm = new MembershipPeriodStateMachine();
    assert.equal(sm.canTransition('HISTORICAL_MEMBER', 'CURRENT_MEMBER'), false);
    assert.equal(sm.canTransition('ENTRY_COMPENSATED', 'ACTIVATION_PROCESSING'), false);
    assert.equal(sm.isTerminal('HISTORICAL_MEMBER'), true);
    assert.equal(sm.isActive('CURRENT_MEMBER'), true);
    // 终态换入防护：版本匹配但试图把终态记录改回活跃状态 → TERMINAL 守卫拒绝
    const rig = makeRig();
    const current = await makeCurrentMember(rig);
    await rig.reconcileExternal.execute({ periodId: current.periodId, trustedConfirmed: true });
    const terminalNow = await rig.repo.load(current.periodId);
    assert.ok(terminalNow !== null && terminalNow.status === 'HISTORICAL_MEMBER');
    const resurrectAttempt = {
      ...terminalNow,
      version: terminalNow.version + 1,
      status: 'CURRENT_MEMBER' as const,
    };
    const swapped = await rig.repo.compareAndSwap(terminalNow!, resurrectAttempt);
    assert.equal(swapped, false, '终态不可复活（TERMINAL 守卫）');
    const reloaded = await rig.repo.load(current.periodId);
    assert.equal(reloaded?.status, 'HISTORICAL_MEMBER');
  });
});

describe('5.2.1 成员经历 MEM-001 · 第二轮修复回归（N1~N4）', () => {
  it('N4：外部写入抛异常时围栏释放、尝试留痕，保持处理中可安全重投', async () => {
    const throwing = new StubCasdoorPort();
    throwing.addAndReadBack = async (): Promise<GroupStepResult[]> => {
      throw new Error('casdoor connection reset (token redacted)');
    };
    const rig = makeRig(throwing as unknown as StubCasdoorPort);
    const p = await rig.enter.execute(enterInput);
    const r = await rig.resolveActivation.execute({
      periodId: p.periodId,
      deadlineExceeded: false,
    });
    assert.equal(r.activated, false);
    // 围栏已释放（不滞留 WRITING），补偿方向不被永久阻塞
    assert.equal(r.period.activation?.phase, 'PENDING');
    assert.equal(r.period.activation?.attemptCount, 1);
    assert.match(r.period.activation?.lastError ?? '', /connection reset/);

    // 异方向不再 Busy：补偿可立即接管执行
    const c = await rig.compensate.execute({ periodId: p.periodId });
    assert.equal(c.compensated, true);
  });

  it('N4：异方向占用超 15 分钟允许超时接管（未超时仍 Busy）', async () => {
    const rig = makeRig();
    const p = await rig.enter.execute(enterInput);
    const staleFence = {
      ...p,
      version: p.version + 1,
      activation: {
        ...p.activation!,
        phase: 'COMPENSATING' as const,
        fencedAt: new Date(Date.now() - 16 * 60 * 1000).toISOString(),
      },
    };
    await rig.repo.compareAndSwap(p, staleFence);
    // 未超时的占用仍然拒绝（用新 rig 验证）
    const rig2 = makeRig();
    const p2 = await rig2.enter.execute(enterInput);
    const freshFence = {
      ...p2,
      version: p2.version + 1,
      activation: {
        ...p2.activation!,
        phase: 'COMPENSATING' as const,
        fencedAt: new Date().toISOString(),
      },
    };
    await rig2.repo.compareAndSwap(p2, freshFence);
    await assert.rejects(
      rig2.resolveActivation.execute({ periodId: p2.periodId, deadlineExceeded: false }),
      (e: unknown) => e instanceof ActivationBusyError,
    );
    // 超时接管：激活解析成功推进到当前成员
    const r = await rig.resolveActivation.execute({
      periodId: p.periodId,
      deadlineExceeded: false,
    });
    assert.equal(r.activated, true);
    assert.equal(r.period.status, 'CURRENT_MEMBER');
  });

  it('N1：恢复态人工重试续跑全程版本单调递增，收口版本大于重入版本', async () => {
    const failingThenIntact = new StubCasdoorPort(
      [],
      [
        [
          {
            target: { kind: 'CLUB', refId: 'c1' },
            ok: false,
            confirmed: false,
            reason: 'gateway-timeout',
          },
        ],
      ],
      [true],
    );
    const rig = makeRig(failingThenIntact);
    seedStandard(rig);
    const current = await makeCurrentMember(rig);
    await rig.requestDeparture.execute({
      periodId: current.periodId,
      requesterId: 'stu1',
      secondConfirmed: true,
    });
    const departing = await rig.approveDeparture.execute({
      periodId: current.periodId,
      approverId: 'hr1',
      action: 'approve',
      relationSnapshot: [],
    });
    const restored = await rig.executeDeparture.execute({
      periodId: departing.periodId,
      deadlineExceeded: true,
    });
    const restoredVersion = restored.period.version;
    const retried = await rig.executeDeparture.execute({
      periodId: departing.periodId,
      deadlineExceeded: false,
      manualRetry: true,
      actorId: 'hr1',
    });
    assert.equal(retried.ended, true);
    // 版本单调：收口版本必须严格大于恢复时版本（N1：此前存在停摆）
    assert.ok(
      retried.period.version > restoredVersion,
      'version=' + retried.period.version + ' restored=' + restoredVersion,
    );
    // 重入落座（转换5边）与收口各推进一次版本：恰好 +2
    assert.equal(retried.period.version - restoredVersion, 2);
  });

  it('N2：多轮提交-驳回后决定归档链完整保留（不止最后一条）', async () => {
    const rig = makeRig();
    seedStandard(rig);
    let current = await makeCurrentMember(rig);
    for (let round = 1; round <= 3; round++) {
      await rig.requestDeparture.execute({
        periodId: current.periodId,
        requesterId: 'stu1',
        secondConfirmed: true,
      });
      current = await rig.approveDeparture.execute({
        periodId: current.periodId,
        approverId: 'hr1',
        action: 'reject',
        rejectionReason: '第' + round + '次驳回原因',
        relationSnapshot: [],
      });
    }
    // 第 4 次提交后：前 3 轮驳回全部在档
    await rig.requestDeparture.execute({
      periodId: current.periodId,
      requesterId: 'stu1',
      secondConfirmed: true,
    });
    const reloaded = await rig.repo.load(current.periodId);
    assert.equal(reloaded?.departure?.priorDecisions.length, 3);
    assert.equal(reloaded?.departure?.priorDecisions[0]?.rejectionReason, '第1次驳回原因');
    assert.equal(reloaded?.departure?.priorDecisions[2]?.rejectionReason, '第3次驳回原因');
  });

  it('N3：跨申请周期的通知去重键互不相同（驳回/批准按周期区分）', async () => {
    const rig = makeRig();
    seedStandard(rig);
    let current = await makeCurrentMember(rig);
    for (let round = 1; round <= 2; round++) {
      await rig.requestDeparture.execute({
        periodId: current.periodId,
        requesterId: 'stu1',
        secondConfirmed: true,
      });
      current = await rig.approveDeparture.execute({
        periodId: current.periodId,
        approverId: 'hr1',
        action: 'reject',
        rejectionReason: '第' + round + '轮',
        relationSnapshot: [],
      });
    }
    const facts = await rig.notify.list();
    const rejectedFacts = facts.filter((f) => f.kind === 'MEMBER_DEPARTURE_REJECTED');
    assert.equal(rejectedFacts.length, 2, '两轮驳回通知都应落事实（去重键含周期）');
    assert.notEqual(rejectedFacts[0]?.dedupKey, rejectedFacts[1]?.dedupKey);
  });
});
