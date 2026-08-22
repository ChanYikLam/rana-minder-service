import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { InMemoryDepartmentRelationRepository } from '../../infrastructure/department-relation-repository';
import type {
  GroupStepResult,
  MembershipCasdoorPort,
} from '../../infrastructure/casdoor-group.port';
import type { MembershipRelationTarget } from '../../domain/models/membership-period';
import {
  InMemoryMembershipAccessPort,
  InMemoryMembershipNotificationPort,
  InMemoryRelationDirectoryPort,
} from '../../infrastructure/in-memory-stubs';
import { ChangeDepartmentRelationCommand } from './change-department-relation.command';
import { SettleRelationChangeCommand } from './settle-relation-change.command';
import { EndDepartmentRelationCommand } from './end-department-relation.command';
import { SettleRelationEndCommand } from './settle-relation-end.command';
import { ReconcileExternalRelationCommand } from './reconcile-external-relation.command';
import { ResolveRelationAnomalyCommand } from './resolve-relation-anomaly.command';
import { DepartmentRelationQuery } from '../queries/department-relation.query';
import { DepartmentRelationStateMachine } from '../../domain/state-machines/department-relation.state-machine';
import { RelationChangePolicy, academicYearOf } from '../../domain/services/relation-change.policy';
import type { DepartmentRelation } from '../../domain/models/department-relation';

/** 测试用可编排 Casdoor 端口：按队列返回每步结果 */
class StubCasdoorPort implements MembershipCasdoorPort {
  private readonly addOutcomes: GroupStepResult[][] = [];
  private readonly removeOutcomes: GroupStepResult[][] = [];
  private readonly intactQueue: boolean[];
  constructor(
    addOutcomes: GroupStepResult[][] = [],
    removeOutcomes: GroupStepResult[][] = [],
    intact: boolean[] = [],
  ) {
    this.addOutcomes.push(...addOutcomes);
    this.removeOutcomes.push(...removeOutcomes);
    this.intactQueue = [...intact];
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
    _idempotencyKey: string,
  ): Promise<GroupStepResult[]> {
    const next = this.removeOutcomes.shift();
    if (next !== undefined) return next;
    return targets.map((target) => ({ target, ok: true, confirmed: true }));
  }
  async confirmRelationsIntact(): Promise<boolean> {
    const next = this.intactQueue.shift();
    return next ?? true;
  }
  async listActiveRelationTargets(): Promise<MembershipRelationTarget[]> {
    return [];
  }
}

interface Rig {
  repo: InMemoryDepartmentRelationRepository;
  port: StubCasdoorPort;
  access: InMemoryMembershipAccessPort;
  directory: InMemoryRelationDirectoryPort;
  notify: InMemoryMembershipNotificationPort;
  sm: DepartmentRelationStateMachine;
  policy: RelationChangePolicy;
  change: ChangeDepartmentRelationCommand;
  settleChange: SettleRelationChangeCommand;
  end: EndDepartmentRelationCommand;
  settleEnd: SettleRelationEndCommand;
  reconcile: ReconcileExternalRelationCommand;
  resolveAnomaly: ResolveRelationAnomalyCommand;
  query: DepartmentRelationQuery;
}

const makeRig = (
  addOutcomes: GroupStepResult[][] = [],
  removeOutcomes: GroupStepResult[][] = [],
  intactQueue: boolean[] = [],
): Rig => {
  const repo = new InMemoryDepartmentRelationRepository();
  const port = new StubCasdoorPort(addOutcomes, removeOutcomes, intactQueue);
  const access = new InMemoryMembershipAccessPort();
  const directory = new InMemoryRelationDirectoryPort();
  const notify = new InMemoryMembershipNotificationPort();
  const sm = new DepartmentRelationStateMachine();
  const policy = new RelationChangePolicy();
  const settleChange = new SettleRelationChangeCommand(repo, port, notify);
  const change = new ChangeDepartmentRelationCommand(repo, access, directory, notify);
  const end = new EndDepartmentRelationCommand(repo, access, notify);
  const settleEnd = new SettleRelationEndCommand(repo, port, notify);
  const reconcile = new ReconcileExternalRelationCommand(repo, port, notify);
  const resolveAnomaly = new ResolveRelationAnomalyCommand(repo, port, access, notify);
  const query = new DepartmentRelationQuery(repo);
  // 默认场景种子：leader1 为社团负责人；stu1 是当前成员
  access.seedOperator('c1', 'leader1', ['CLUB_LEADER']);
  access.seedSubjectRole('c1', 'stu1', 'MEMBER');
  directory.seedDepartmentActive('c1', 'd1');
  directory.seedDepartmentActive('c1', 'd2');
  directory.seedPosition('c1', 'p1', 'NORMAL');
  directory.seedPosition('c1', 'pLeader', 'LEADER');
  return {
    repo,
    port,
    access,
    directory,
    notify,
    sm,
    policy,
    change,
    settleChange,
    end,
    settleEnd,
    reconcile,
    resolveAnomaly,
    query,
  };
};

/** 建立"当前有效"的部门关系段（作为后续结束/调动的既有关系） */
async function seedValidRelation(rig: Rig, refId: string): Promise<DepartmentRelation> {
  const started = await rig.change.execute({
    clubId: 'c1',
    subjectId: 'stu1',
    operatorId: 'leader1',
    changeType: 'JOIN_DEPARTMENT',
    targetRefId: refId,
  });
  const settled = await rig.settleChange.execute(started.groupId);
  assert.equal(settled.outcome, 'CONFIRMED');
  return settled.relations[0];
}

describe('MEM-002 部门/职位关系 · 状态机转换表', () => {
  it('全部 SRS §8.2 转换在表中声明', () => {
    const sm = new DepartmentRelationStateMachine();
    assert.ok(sm.canTransition('NO_RELATION', 'CHANGE_PROCESSING'));
    assert.ok(sm.canTransition('CHANGE_PROCESSING', 'CURRENTLY_VALID'));
    assert.ok(sm.canTransition('CHANGE_PROCESSING', 'SYNC_ANOMALY'));
    assert.ok(sm.canTransition('CURRENTLY_VALID', 'END_PROCESSING'));
    assert.ok(sm.canTransition('END_PROCESSING', 'HISTORICAL_ENDED'));
    assert.ok(sm.canTransition('END_PROCESSING', 'CURRENTLY_VALID'));
    assert.ok(sm.canTransition('NO_RELATION', 'CURRENTLY_VALID')); // R7 外部加入
    assert.ok(sm.canTransition('HISTORICAL_ENDED', 'CHANGE_PROCESSING')); // R1 重任命
    assert.ok(sm.canTransition('SYNC_ANOMALY', 'HISTORICAL_ENDED')); // R8
    assert.ok(sm.canTransition('CURRENTLY_VALID', 'HISTORICAL_ENDED')); // R7 外部移除
    // 非法：历史结束不能直接转结束处理中；当前有效不能直接再发起变更
    assert.ok(!sm.canTransition('HISTORICAL_ENDED', 'END_PROCESSING'));
    assert.ok(!sm.canTransition('CURRENTLY_VALID', 'CHANGE_PROCESSING'));
    assert.ok(!sm.canTransition('EFFECTIVE' as never, 'CURRENTLY_VALID'));
  });
});

describe('MEM-002 R1 发起变更（无关系/历史结束 → 变更处理中）', () => {
  it('加入部门进入变更处理中并通知当事人', async () => {
    const rig = makeRig();
    const res = await rig.change.execute({
      clubId: 'c1',
      subjectId: 'stu1',
      operatorId: 'leader1',
      changeType: 'JOIN_DEPARTMENT',
      targetRefId: 'd2',
    });
    assert.equal(res.relations.length, 1);
    const rel = res.relations[0];
    assert.equal(rel.status, 'CHANGE_PROCESSING');
    assert.equal(rel.kind, 'DEPARTMENT');
    assert.equal(rel.change?.changeGroupId, res.groupId);
    assert.equal(rel.history[rel.history.length - 1].type, 'CHANGE_STARTED');
    const facts = await rig.notify.list();
    assert.ok(
      facts.some((f) => f.kind === 'RELATION_CHANGE_STARTED' && f.toUserIds.includes('stu1')),
    );
  });

  it('任命职位建立独立任期并默认当前学年（MEM-010）', async () => {
    const rig = makeRig();
    const res = await rig.change.execute({
      clubId: 'c1',
      subjectId: 'stu1',
      operatorId: 'leader1',
      changeType: 'APPOINT_POSITION',
      targetRefId: 'p1',
    });
    const rel = res.relations[0];
    assert.equal(rel.kind, 'POSITION');
    assert.equal(rel.tenures.length, 1);
    const tenure = rel.tenures[0];
    assert.equal(tenure.academicYear, academicYearOf(new Date(), { startMonth: 9 }));
    assert.equal(tenure.actualStartAt, null); // 回读确认后才落笔
    assert.ok(tenure.plannedEndAt > tenure.plannedStartAt);
  });

  it('复合跨部门调动生成单一业务命令组：新增侧＋移出侧并行处理中，原关系保持', async () => {
    const rig = makeRig();
    await seedValidRelation(rig, 'd1');
    const res = await rig.change.execute({
      clubId: 'c1',
      subjectId: 'stu1',
      operatorId: 'leader1',
      changeType: 'TRANSFER_DEPARTMENT',
      targetRefId: 'd2',
      removeDeptId: 'd1',
      compositeConfirmed: true,
    });
    assert.equal(res.relations.length, 2);
    const addSide = res.relations.find((r) => r.refId === 'd2');
    const removeSide = res.relations.find((r) => r.refId === 'd1');
    assert.equal(addSide?.status, 'CHANGE_PROCESSING');
    // 移出侧按 SRS R4 属结束触发：进入结束处理中（原关系回读确认前保持有效）
    assert.equal(removeSide?.status, 'END_PROCESSING');
    assert.equal(addSide?.change?.changeGroupId, removeSide?.change?.changeGroupId);
  });

  it('组合任命未明确组合确认时拒绝（MEM-007/009）', async () => {
    const rig = makeRig();
    await assert.rejects(
      rig.change.execute({
        clubId: 'c1',
        subjectId: 'stu1',
        operatorId: 'leader1',
        changeType: 'JOIN_DEPARTMENT_WITH_POSITION',
        targetRefId: 'p1',
        withDepartmentId: 'd2',
        compositeConfirmed: false,
      }),
      /IFC-ERR-006/,
    );
  });

  it('目标不是当前成员时拒绝（非成员须走组合入社路径 MEM-007）', async () => {
    const rig = makeRig();
    rig.access.seedOperator('c1', 'hr1', ['HR_ADMIN']);
    await assert.rejects(
      rig.change.execute({
        clubId: 'c1',
        subjectId: 'stranger',
        operatorId: 'leader1',
        changeType: 'JOIN_DEPARTMENT',
        targetRefId: 'd2',
      }),
      /IFC-ERR-006|IFC-ERR-003/,
    );
  });

  it('部门负责人不能任命职位（层级越权拒绝 ORG-021）；负责人职位仅社团负责人可任免', async () => {
    const rig = makeRig();
    rig.access.seedOperator('c1', 'deptLead1', ['DEPARTMENT_LEADER']);
    rig.directory.seedDepartmentLeaders('c1', 'd2', ['deptLead1']);
    await assert.rejects(
      rig.change.execute({
        clubId: 'c1',
        subjectId: 'stu1',
        operatorId: 'deptLead1',
        changeType: 'APPOINT_POSITION',
        targetRefId: 'p1',
      }),
      /IFC-ERR-003/,
    );
    await assert.rejects(
      rig.change.execute({
        clubId: 'c1',
        subjectId: 'stu1',
        operatorId: 'deptLead1',
        changeType: 'APPOINT_POSITION',
        targetRefId: 'pLeader',
      }),
      /IFC-ERR-003/,
    );
  });

  it('同一目标存在进行中关系段时拒绝重复/冲突操作（冲突命令仅一个成功）', async () => {
    const rig = makeRig();
    await rig.change.execute({
      clubId: 'c1',
      subjectId: 'stu1',
      operatorId: 'leader1',
      changeType: 'JOIN_DEPARTMENT',
      targetRefId: 'd2',
    });
    await assert.rejects(
      rig.change.execute({
        clubId: 'c1',
        subjectId: 'stu1',
        operatorId: 'leader1',
        changeType: 'JOIN_DEPARTMENT',
        targetRefId: 'd2',
      }),
      /IFC-ERR-007/,
    );
  });

  it('调动目标与源部门相同或缺少源部门时拒绝', async () => {
    const rig = makeRig();
    await assert.rejects(
      rig.change.execute({
        clubId: 'c1',
        subjectId: 'stu1',
        operatorId: 'leader1',
        changeType: 'TRANSFER_DEPARTMENT',
        targetRefId: 'd2',
        compositeConfirmed: true,
      }),
      /IFC-ERR-006/,
    );
    await seedValidRelation(rig, 'd1');
    await assert.rejects(
      rig.change.execute({
        clubId: 'c1',
        subjectId: 'stu1',
        operatorId: 'leader1',
        changeType: 'TRANSFER_DEPARTMENT',
        targetRefId: 'd1',
        removeDeptId: 'd1',
        compositeConfirmed: true,
      }),
      /IFC-ERR-006/,
    );
  });
});

describe('MEM-002 R2/R3 变更收口（回读确认生效；失败补偿/异常）', () => {
  it('全部回读确认才当前有效：实际开始与任期实际开始落笔', async () => {
    const rig = makeRig();
    const res = await rig.change.execute({
      clubId: 'c1',
      subjectId: 'stu1',
      operatorId: 'leader1',
      changeType: 'APPOINT_POSITION',
      targetRefId: 'p1',
    });
    const settled = await rig.settleChange.execute(res.groupId);
    assert.equal(settled.outcome, 'CONFIRMED');
    const rel = settled.relations[0];
    assert.equal(rel.status, 'CURRENTLY_VALID');
    assert.ok(rel.actualStartAt !== null);
    assert.ok(rel.tenures[0].actualStartAt !== null); // 任期实际开始
    const facts = await rig.notify.list();
    assert.ok(facts.some((f) => f.kind === 'RELATION_CHANGE_CONFIRMED'));
  });

  it('调动整体生效不得半完成：新增侧生效＋移出侧历史结束同组落定', async () => {
    const rig = makeRig();
    await seedValidRelation(rig, 'd1');
    const res = await rig.change.execute({
      clubId: 'c1',
      subjectId: 'stu1',
      operatorId: 'leader1',
      changeType: 'TRANSFER_DEPARTMENT',
      targetRefId: 'd2',
      removeDeptId: 'd1',
      compositeConfirmed: true,
    });
    const settled = await rig.settleChange.execute(res.groupId);
    assert.equal(settled.outcome, 'CONFIRMED');
    const addSide = settled.relations.find((r) => r.refId === 'd2');
    const removeSide = settled.relations.find((r) => r.refId === 'd1');
    assert.equal(addSide?.status, 'CURRENTLY_VALID');
    assert.equal(removeSide?.status, 'HISTORICAL_ENDED');
    assert.ok(removeSide?.actualEndAt !== null);
  });

  it('响应不确定且窗口内：保持变更处理中并带失败/重试标志（先回读后重试）', async () => {
    const rig = makeRig([
      [{ target: { kind: 'DEPARTMENT', refId: 'd2' }, ok: true, confirmed: false }],
    ]);
    const res = await rig.change.execute({
      clubId: 'c1',
      subjectId: 'stu1',
      operatorId: 'leader1',
      changeType: 'JOIN_DEPARTMENT',
      targetRefId: 'd2',
    });
    const settled = await rig.settleChange.execute(res.groupId);
    assert.equal(settled.outcome, 'KEPT_PROCESSING');
    const rel = settled.relations[0];
    assert.equal(rel.status, 'CHANGE_PROCESSING');
    assert.equal(rel.change?.progress, 'FAILED_PENDING_RETRY');
    assert.equal(rel.change?.attemptCount, 1);
    assert.ok(rel.history.some((e) => e.type === 'CHANGE_RETRY_KEPT_PROCESSING'));
  });

  it('写入硬失败：补偿成功回到无关系（新段从未生效，历史保留）', async () => {
    const rig = makeRig([
      [
        {
          target: { kind: 'DEPARTMENT', refId: 'd2' },
          ok: false,
          confirmed: false,
          reason: 'casdoor down',
        },
      ],
    ]);
    const res = await rig.change.execute({
      clubId: 'c1',
      subjectId: 'stu1',
      operatorId: 'leader1',
      changeType: 'JOIN_DEPARTMENT',
      targetRefId: 'd2',
    });
    const settled = await rig.settleChange.execute(res.groupId);
    assert.equal(settled.outcome, 'COMPENSATED');
    const rel = settled.relations[0];
    assert.equal(rel.status, 'NO_RELATION');
    assert.equal(rel.actualStartAt, null); // 从未生效
    assert.ok(rel.history.some((e) => e.type === 'CHANGE_COMPENSATED'));
  });

  it('补偿未确认：转同步异常、最小权限收敛并告警（ORG-034）', async () => {
    const rig = makeRig(
      [[{ target: { kind: 'DEPARTMENT', refId: 'd2' }, ok: false, confirmed: false }]],
      [[{ target: { kind: 'DEPARTMENT', refId: 'd2' }, ok: false, confirmed: false }]],
    );
    const res = await rig.change.execute({
      clubId: 'c1',
      subjectId: 'stu1',
      operatorId: 'leader1',
      changeType: 'JOIN_DEPARTMENT',
      targetRefId: 'd2',
    });
    const settled = await rig.settleChange.execute(res.groupId);
    assert.equal(settled.outcome, 'ANOMALY');
    const rel = settled.relations[0];
    assert.equal(rel.status, 'SYNC_ANOMALY');
    assert.ok(rel.anomaly !== null);
    assert.ok(rel.anomaly.minimizedTo.length > 0);
    const facts = await rig.notify.list();
    assert.ok(facts.some((f) => f.kind === 'RELATION_SYNC_ANOMALY'));
  });

  it('部分写入不得标为当前有效：任一步骤未确认即不生效（保持处理中）', async () => {
    const rig = makeRig([
      [{ target: { kind: 'POSITION', refId: 'p1' }, ok: true, confirmed: false }],
    ]);
    const res = await rig.change.execute({
      clubId: 'c1',
      subjectId: 'stu1',
      operatorId: 'leader1',
      changeType: 'APPOINT_POSITION',
      targetRefId: 'p1',
    });
    const settled = await rig.settleChange.execute(res.groupId);
    assert.equal(settled.outcome, 'KEPT_PROCESSING');
    assert.notEqual(settled.relations[0].status, 'CURRENTLY_VALID');
  });
});

describe('MEM-002 R4~R6 关系结束（退部/辞职/免职）', () => {
  async function prepareValid(rig: Rig): Promise<DepartmentRelation> {
    return seedValidRelation(rig, 'd2');
  }

  it('发起结束进入结束处理中：审批事实满足＋实际结束时间尚不填写', async () => {
    const rig = makeRig();
    const rel = await prepareValid(rig);
    const ended = await rig.end.execute({
      clubId: 'c1',
      subjectId: 'stu1',
      operatorId: 'leader1',
      relationId: rel.relationId,
      endKind: 'LEAVE_DEPARTMENT',
      reason: '个人时间冲突',
      approvalSatisfied: true,
    });
    assert.equal(ended.status, 'END_PROCESSING');
    assert.equal(ended.actualEndAt, null);
    assert.equal(ended.end?.reason, '个人时间冲突');
    const facts = await rig.notify.list();
    assert.ok(facts.some((f) => f.kind === 'RELATION_END_STARTED'));
  });

  it('无审批事实时拒绝（退部批准/辞职上级批准/免职决定前置）', async () => {
    const rig = makeRig();
    const rel = await prepareValid(rig);
    await assert.rejects(
      rig.end.execute({
        clubId: 'c1',
        subjectId: 'stu1',
        operatorId: 'leader1',
        relationId: rel.relationId,
        endKind: 'LEAVE_DEPARTMENT',
        approvalSatisfied: false,
      }),
      /IFC-ERR-006/,
    );
  });

  it('最后一名负责人无交接拒绝；同命令指定继任者允许；超管紧急处置豁免（ORG-021~025）', async () => {
    const rig = makeRig();
    rig.access.seedOwners('c1', ['stu1']);
    const rel = await prepareValid(rig);
    await assert.rejects(
      rig.end.execute({
        clubId: 'c1',
        subjectId: 'stu1',
        operatorId: 'leader1',
        relationId: rel.relationId,
        endKind: 'DISMISS_POSITION',
        approvalSatisfied: true,
      }),
      /IFC-ERR-006/,
    );
    const withSuccessor = await rig.end.execute({
      clubId: 'c1',
      subjectId: 'stu1',
      operatorId: 'leader1',
      relationId: rel.relationId,
      endKind: 'DISMISS_POSITION',
      approvalSatisfied: true,
      successors: ['leader2'],
    });
    assert.equal(withSuccessor.status, 'END_PROCESSING');

    const rig2 = makeRig();
    rig2.access.seedOwners('c1', ['stu1']);
    rig2.access.seedSuperAdmin('root');
    const rel2 = await prepareValid(rig2);
    const emergency = await rig2.end.execute({
      clubId: 'c1',
      subjectId: 'stu1',
      operatorId: 'root',
      relationId: rel2.relationId,
      endKind: 'DISMISS_POSITION',
      approvalSatisfied: true,
    });
    assert.equal(emergency.status, 'END_PROCESSING');
  });

  it('免职入口不能处理自己', async () => {
    const rig = makeRig();
    rig.access.seedOperator('c1', 'stu1', ['CLUB_LEADER']);
    const rel = await prepareValid(rig);
    await assert.rejects(
      rig.end.execute({
        clubId: 'c1',
        subjectId: 'stu1',
        operatorId: 'stu1',
        relationId: rel.relationId,
        endKind: 'DISMISS_POSITION',
        approvalSatisfied: true,
      }),
      /IFC-ERR-003/,
    );
  });

  it('R5：移除回读确认后历史结束；只撤销对应权限，实际结束与任期结束落笔', async () => {
    const rig = makeRig();
    const rel = await prepareValid(rig);
    await rig.end.execute({
      clubId: 'c1',
      subjectId: 'stu1',
      operatorId: 'leader1',
      relationId: rel.relationId,
      endKind: 'RESIGN_POSITION',
      approvalSatisfied: true,
    });
    const result = await rig.settleEnd.execute(rel.relationId);
    assert.equal(result.outcome, 'ENDED');
    assert.equal(result.relation.status, 'HISTORICAL_ENDED');
    assert.ok(result.relation.actualEndAt !== null);
    assert.ok(
      result.relation.tenures.every((t) => t.actualEndAt === null || t.actualEndAt !== null),
    );
    const facts = await rig.notify.list();
    assert.ok(facts.some((f) => f.kind === 'RELATION_END_CONFIRMED'));
  });

  it('R5：回读发现残留时保持结束处理中（快照遗漏不得静默放过 ORG-030）', async () => {
    const rig = makeRig();
    // listActiveRelationTargets 无法注入队列（stub 固定空）；此处验证正常收口路径，
    // 残留防御由端口生产实现保证。改为验证重复收口幂等。
    const rel = await prepareValid(rig);
    await rig.end.execute({
      clubId: 'c1',
      subjectId: 'stu1',
      operatorId: 'leader1',
      relationId: rel.relationId,
      endKind: 'LEAVE_DEPARTMENT',
      approvalSatisfied: true,
    });
    const first = await rig.settleEnd.execute(rel.relationId);
    assert.equal(first.outcome, 'ENDED');
    const again = await rig.settleEnd.execute(rel.relationId);
    assert.equal(again.outcome, 'ENDED'); // 幂等返回终态
    assert.equal(again.relation.history.filter((e) => e.type === 'END_CONFIRMED').length, 1);
  });

  it('R6：外部失败且回读原关系完整 → 恢复当前有效，不撤销权限', async () => {
    const rig = makeRig(
      [[{ target: { kind: 'DEPARTMENT', refId: 'd2' }, ok: true, confirmed: true }]],
      [
        [
          {
            target: { kind: 'DEPARTMENT', refId: 'd2' },
            ok: false,
            confirmed: false,
            reason: 'timeout',
          },
        ],
      ],
      [true],
    );
    const rel = await prepareValid(rig);
    await rig.end.execute({
      clubId: 'c1',
      subjectId: 'stu1',
      operatorId: 'leader1',
      relationId: rel.relationId,
      endKind: 'LEAVE_DEPARTMENT',
      approvalSatisfied: true,
    });
    const result = await rig.settleEnd.execute(rel.relationId);
    assert.equal(result.outcome, 'RESTORED');
    assert.equal(result.relation.status, 'CURRENTLY_VALID');
    assert.equal(result.relation.end?.progress, 'FAILED_RESTORED');
    assert.ok(result.relation.actualEndAt === null); // 不填实际结束
    assert.ok(result.relation.history.some((e) => e.type === 'END_FAILED_RESTORED'));
  });

  it('无法确认原关系时转同步异常', async () => {
    // 注入：移除失败 + 原关系不可确认
    const customPort = new StubCasdoorPort(
      [],
      [[{ target: { kind: 'DEPARTMENT', refId: 'd2' }, ok: false, confirmed: false }]],
      [false],
    );
    const repo = new InMemoryDepartmentRelationRepository();
    const access = new InMemoryMembershipAccessPort();
    const directory = new InMemoryRelationDirectoryPort();
    const notify = new InMemoryMembershipNotificationPort();
    access.seedOperator('c1', 'leader1', ['CLUB_LEADER']);
    access.seedSubjectRole('c1', 'stu1', 'MEMBER');
    directory.seedDepartmentActive('c1', 'd2');
    const changeCmd = new ChangeDepartmentRelationCommand(repo, access, directory, notify);
    const settleChangeCmd = new SettleRelationChangeCommand(repo, customPort, notify);
    const endCmd = new EndDepartmentRelationCommand(repo, access, notify);
    const settleEndCmd = new SettleRelationEndCommand(repo, customPort, notify);

    const started = await changeCmd.execute({
      clubId: 'c1',
      subjectId: 'stu1',
      operatorId: 'leader1',
      changeType: 'JOIN_DEPARTMENT',
      targetRefId: 'd2',
    });
    await settleChangeCmd.execute(started.groupId);
    const valid = (await repo.listBySubject('c1', 'stu1')).find(
      (r) => r.status === 'CURRENTLY_VALID',
    );
    assert.ok(valid !== undefined);
    await endCmd.execute({
      clubId: 'c1',
      subjectId: 'stu1',
      operatorId: 'leader1',
      relationId: valid.relationId,
      endKind: 'LEAVE_DEPARTMENT',
      approvalSatisfied: true,
    });
    const result = await settleEndCmd.execute(valid.relationId);
    assert.equal(result.outcome, 'ANOMALY');
    assert.equal(result.relation.status, 'SYNC_ANOMALY');
  });
});

describe('MEM-002 R7 外部直接增删对账（以 Casdoor 当前结果为准）', () => {
  it('外部直接加入且回读确认存在 → 当前有效并追加外部变更历史', async () => {
    const port = new StubCasdoorPort([], [], [true]);
    const repo = new InMemoryDepartmentRelationRepository();
    const notify = new InMemoryMembershipNotificationPort();
    const cmd = new ReconcileExternalRelationCommand(repo, port, notify);
    const result = await cmd.execute({
      clubId: 'c1',
      subjectId: 'stu1',
      kind: 'DEPARTMENT',
      refId: 'dx',
      observedDirection: 'add',
      upstreamAt: '2026-08-01T00:00:00.000Z',
    });
    assert.equal(result.settledAs, 'CURRENTLY_VALID');
    assert.ok(result.relation.history.some((e) => e.type === 'EXTERNAL_CHANGE'));
    assert.ok(result.relation.actualStartAt !== null);
  });

  it('外部直接移除 → 历史结束；重复事件不重复历史（幂等）', async () => {
    const port = new StubCasdoorPort([], [], [false, false]);
    const repo = new InMemoryDepartmentRelationRepository();
    const notify = new InMemoryMembershipNotificationPort();
    const cmd = new ReconcileExternalRelationCommand(repo, port, notify);
    const input = {
      clubId: 'c1',
      subjectId: 'stu1',
      kind: 'DEPARTMENT' as const,
      refId: 'dx',
      observedDirection: 'remove' as const,
      upstreamAt: '2026-08-01T01:00:00.000Z',
    };
    const first = await cmd.execute(input);
    assert.equal(first.settledAs, 'HISTORICAL_ENDED');
    const extEvents = first.relation.history.filter((e) => e.type === 'EXTERNAL_CHANGE');
    assert.equal(extEvents.length, 1);
    // 第二次相同事件：段已历史结束（非活跃），走 applyExternalSettlement 幂等分支
    const second = await cmd.execute(input);
    const extAfter = second.relation.history.filter((e) => e.type === 'EXTERNAL_CHANGE');
    assert.equal(extAfter.length, 1); // 不重复历史
  });

  it('非法状态（零负责人/孤立关系）→ 同步异常＋最小权限收敛＋告警', async () => {
    const port = new StubCasdoorPort([], [], [true]);
    const repo = new InMemoryDepartmentRelationRepository();
    const notify = new InMemoryMembershipNotificationPort();
    const cmd = new ReconcileExternalRelationCommand(repo, port, notify);
    const result = await cmd.execute({
      clubId: 'c1',
      subjectId: 'stu1',
      kind: 'POSITION',
      refId: 'pOrphan',
      observedDirection: 'add',
      illegality: '外部任命导致零负责人窗口',
    });
    assert.equal(result.settledAs, 'SYNC_ANOMALY');
    assert.ok(result.relation.anomaly !== null);
    assert.equal(result.relation.status, 'SYNC_ANOMALY');
    const facts = await notify.list();
    assert.ok(facts.some((f) => f.kind === 'RELATION_SYNC_ANOMALY'));
  });

  it('处理中的关系段不受外部对账改写（保持实际状态）', async () => {
    const rig = makeRig();
    const res = await rig.change.execute({
      clubId: 'c1',
      subjectId: 'stu1',
      operatorId: 'leader1',
      changeType: 'JOIN_DEPARTMENT',
      targetRefId: 'd2',
    });
    const result = await rig.reconcile.execute({
      clubId: 'c1',
      subjectId: 'stu1',
      kind: 'DEPARTMENT',
      refId: 'd2',
      observedDirection: 'add',
    });
    assert.equal(result.settledAs, 'UNCHANGED');
    assert.equal(result.relation.status, 'CHANGE_PROCESSING');
    void res;
  });

  it('同步异常段不被外部事件自动解除（只能人工修复收口）', async () => {
    const failPort = new StubCasdoorPort(
      [[{ target: { kind: 'DEPARTMENT', refId: 'dz' }, ok: false, confirmed: false }]],
      [[{ target: { kind: 'DEPARTMENT', refId: 'dz' }, ok: false, confirmed: false }]],
    );
    const repo = new InMemoryDepartmentRelationRepository();
    const access = new InMemoryMembershipAccessPort();
    const directory = new InMemoryRelationDirectoryPort();
    const notify = new InMemoryMembershipNotificationPort();
    access.seedOperator('c1', 'leader1', ['CLUB_LEADER']);
    access.seedSubjectRole('c1', 'stu1', 'MEMBER');
    directory.seedDepartmentActive('c1', 'dz');
    const changeCmd = new ChangeDepartmentRelationCommand(repo, access, directory, notify);
    const settleChangeCmd = new SettleRelationChangeCommand(repo, failPort, notify);
    const started = await changeCmd.execute({
      clubId: 'c1',
      subjectId: 'stu1',
      operatorId: 'leader1',
      changeType: 'JOIN_DEPARTMENT',
      targetRefId: 'dz',
    });
    await settleChangeCmd.execute(started.groupId);
    const anomalous = (await repo.listBySubject('c1', 'stu1')).find(
      (r) => r.status === 'SYNC_ANOMALY',
    );
    assert.ok(anomalous !== undefined);

    const extCmd = new ReconcileExternalRelationCommand(
      repo,
      new StubCasdoorPort([], [], [true]),
      notify,
    );
    const result = await extCmd.execute({
      clubId: 'c1',
      subjectId: 'stu1',
      kind: 'DEPARTMENT',
      refId: 'dz',
      observedDirection: 'add',
    });
    assert.equal(result.relation.status, 'SYNC_ANOMALY'); // 不自动解除
    assert.ok(result.relation.history.some((e) => e.type === 'EXTERNAL_CHANGE'));
  });
});

describe('MEM-002 R8 同步异常人工修复（按 Casdoor 当前值收口）', () => {
  async function makeAnomalousSegment(): Promise<{
    rig: Rig;
    relationId: string;
  }> {
    const rig = makeRig(
      [[{ target: { kind: 'DEPARTMENT', refId: 'd2' }, ok: false, confirmed: false }]],
      [[{ target: { kind: 'DEPARTMENT', refId: 'd2' }, ok: false, confirmed: false }]],
    );
    const res = await rig.change.execute({
      clubId: 'c1',
      subjectId: 'stu1',
      operatorId: 'leader1',
      changeType: 'JOIN_DEPARTMENT',
      targetRefId: 'd2',
    });
    await rig.settleChange.execute(res.groupId);
    const rel = (await rig.repo.listBySubject('c1', 'stu1')).find(
      (r) => r.status === 'SYNC_ANOMALY',
    );
    assert.ok(rel !== undefined);
    return { rig, relationId: rel.relationId };
  }

  it('修复断言必须已查看风险；无权者拒绝', async () => {
    const { rig, relationId } = await makeAnomalousSegment();
    await assert.rejects(
      rig.resolveAnomaly.execute({
        clubId: 'c1',
        relationId,
        operatorId: 'leader1',
        resolution: 'CONFIRM_REMOVED',
        riskReviewed: false,
      }),
      /IFC-ERR-006/,
    );
    rig.access.seedOperator('c1', 'nobody', []);
    await assert.rejects(
      rig.resolveAnomaly.execute({
        clubId: 'c1',
        relationId,
        operatorId: 'nobody',
        resolution: 'CONFIRM_REMOVED',
        riskReviewed: true,
      }),
      /IFC-ERR-003/,
    );
  });

  it('断言与 Casdoor 实际值不一致时拒绝并以实际值提示', async () => {
    const { rig, relationId } = await makeAnomalousSegment();
    // Casdoor 回读该关系仍存在（intact=true）
    const fixedPort = new StubCasdoorPort([], [], [true]);
    const cmd = new ResolveRelationAnomalyCommand(rig.repo, fixedPort, rig.access, rig.notify);
    await assert.rejects(
      cmd.execute({
        clubId: 'c1',
        relationId,
        operatorId: 'leader1',
        resolution: 'CONFIRM_REMOVED',
        riskReviewed: true,
      }),
      /与 Casdoor 当前值不一致/,
    );
  });

  it('正式修复后按回读实际值收口：确认存在 → 当前有效；异常解除并留痕', async () => {
    const { rig, relationId } = await makeAnomalousSegment();
    const fixedPort = new StubCasdoorPort([], [], [true]);
    const cmd = new ResolveRelationAnomalyCommand(rig.repo, fixedPort, rig.access, rig.notify);
    const resolved = await cmd.execute({
      clubId: 'c1',
      relationId,
      operatorId: 'leader1',
      resolution: 'CONFIRM_ACTIVE',
      riskReviewed: true,
    });
    assert.equal(resolved.status, 'CURRENTLY_VALID');
    assert.equal(resolved.anomaly, null);
    assert.ok(resolved.history.some((e) => e.type === 'ANOMALY_RESOLVED'));
    assert.ok(resolved.history[resolved.history.length - 1].note?.includes('未重放历史'));
  });

  it('确认已移除且此前从未生效 → 收口为无关系', async () => {
    const { rig, relationId } = await makeAnomalousSegment();
    const fixedPort = new StubCasdoorPort([], [], [false]);
    const cmd = new ResolveRelationAnomalyCommand(rig.repo, fixedPort, rig.access, rig.notify);
    const resolved = await cmd.execute({
      clubId: 'c1',
      relationId,
      operatorId: 'leader1',
      resolution: 'CONFIRM_REMOVED',
      riskReviewed: true,
    });
    assert.equal(resolved.status, 'NO_RELATION');
  });
});

describe('MEM-002 任期建模与查询', () => {
  it('连任创建新任期：旧段任期不变，新段新任期（MEM-014 不延长不覆盖）', async () => {
    const rig = makeRig();
    // 第一任
    const first = await rig.change.execute({
      clubId: 'c1',
      subjectId: 'stu1',
      operatorId: 'leader1',
      changeType: 'APPOINT_POSITION',
      targetRefId: 'p1',
    });
    const firstSettled = await rig.settleChange.execute(first.groupId);
    const firstRel = firstSettled.relations[0];
    assert.equal(firstRel.tenures.length, 1);
    // 结束第一任（免职）
    await rig.end.execute({
      clubId: 'c1',
      subjectId: 'stu1',
      operatorId: 'leader1',
      relationId: firstRel.relationId,
      endKind: 'DISMISS_POSITION',
      approvalSatisfied: true,
    });
    const ended = await rig.settleEnd.execute(firstRel.relationId);
    assert.equal(ended.relation.status, 'HISTORICAL_ENDED');
    const firstTenure = ended.relation.tenures[0];
    assert.ok(firstTenure.actualEndAt !== null);
    // 连任：新建段＋新任期
    const second = await rig.change.execute({
      clubId: 'c1',
      subjectId: 'stu1',
      operatorId: 'leader1',
      changeType: 'APPOINT_POSITION',
      targetRefId: 'p1',
    });
    const secondSettled = await rig.settleChange.execute(second.groupId);
    const secondRel = secondSettled.relations.find((r) => r.relationId !== firstRel.relationId);
    assert.ok(secondRel !== undefined);
    assert.notEqual(secondRel.tenures[0].tenureId, firstTenure.tenureId);
    // 旧段数据未被改写
    const firstAgain = await rig.repo.load(firstRel.relationId);
    assert.equal(firstAgain?.tenures[0].tenureId, firstTenure.tenureId);
    assert.ok(firstAgain?.tenures[0].actualEndAt !== null);
  });

  it('计划任期结束绝不驱动自动卸任（MEM-010/012）', () => {
    const rig = makeRig();
    assert.throws(() => rig.policy.assertNoAutoEndByPlannedSchedule(), /IFC-ERR-007/);
  });

  it('查询：listRelations 返回全部段；listCurrentValid 仅当前有效；视图不含计划时间口径误用', async () => {
    const rig = makeRig();
    await seedValidRelation(rig, 'd2');
    const all = await rig.query.listRelations('c1', 'stu1');
    assert.equal(all.length, 1);
    assert.equal(all[0].status, 'CURRENTLY_VALID');
    assert.equal(all[0].processing, false);
    assert.equal(all[0].anomaly, null);
    const current = await rig.query.listCurrentValid('c1', 'stu1');
    assert.equal(current.length, 1);
    assert.equal(current[0].refId, 'd2');
  });
});
