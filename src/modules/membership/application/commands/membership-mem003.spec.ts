import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { InMemoryDepartmentApplicationRepository } from '../../infrastructure/department-application-repository';
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
import { SubmitDepartmentApplicationCommand } from './submit-department-application.command';
import { WithdrawDepartmentApplicationCommand } from './withdraw-department-application.command';
import { DecideDepartmentApplicationCommand } from './decide-department-application.command';
import {
  ExecuteDepartmentApplicationCommand,
  applicationGroupIdOf,
} from './execute-department-application.command';
import { ResolveRelationAnomalyCommand } from './resolve-relation-anomaly.command';
import { DepartmentApplicationStateMachine } from '../../domain/state-machines/department-application.state-machine';

class StubCasdoorPort implements MembershipCasdoorPort {
  private readonly addOutcomes: GroupStepResult[][] = [];
  private readonly removeOutcomes: GroupStepResult[][] = [];
  constructor(addOutcomes: GroupStepResult[][] = [], removeOutcomes: GroupStepResult[][] = []) {
    this.addOutcomes.push(...addOutcomes);
    this.removeOutcomes.push(...removeOutcomes);
  }
  async addAndReadBack(
    _clubId: string,
    _subjectId: string,
    targets: readonly MembershipRelationTarget[],
  ): Promise<GroupStepResult[]> {
    const next = this.addOutcomes.shift();
    if (next !== undefined) return next;
    return targets.map((target) => ({ target, ok: true, confirmed: true }));
  }
  async removeAllAndReadBack(
    _clubId: string,
    _subjectId: string,
    targets: readonly MembershipRelationTarget[],
  ): Promise<GroupStepResult[]> {
    const next = this.removeOutcomes.shift();
    if (next !== undefined) return next;
    return targets.map((target) => ({ target, ok: true, confirmed: true }));
  }
  async confirmRelationsIntact(): Promise<boolean> {
    return true;
  }
  async listActiveRelationTargets(): Promise<MembershipRelationTarget[]> {
    return [];
  }
}

interface Rig {
  appRepo: InMemoryDepartmentApplicationRepository;
  relRepo: InMemoryDepartmentRelationRepository;
  port: StubCasdoorPort;
  access: InMemoryMembershipAccessPort;
  directory: InMemoryRelationDirectoryPort;
  notify: InMemoryMembershipNotificationPort;
  sm: DepartmentApplicationStateMachine;
  change: ChangeDepartmentRelationCommand;
  settleChange: SettleRelationChangeCommand;
  submit: SubmitDepartmentApplicationCommand;
  withdraw: WithdrawDepartmentApplicationCommand;
  decide: DecideDepartmentApplicationCommand;
  executeApp: ExecuteDepartmentApplicationCommand;
}

const makeRig = (
  addOutcomes: GroupStepResult[][] = [],
  removeOutcomes: GroupStepResult[][] = [],
): Rig => {
  const appRepo = new InMemoryDepartmentApplicationRepository();
  const relRepo = new InMemoryDepartmentRelationRepository();
  const port = new StubCasdoorPort(addOutcomes, removeOutcomes);
  const access = new InMemoryMembershipAccessPort();
  const directory = new InMemoryRelationDirectoryPort();
  const notify = new InMemoryMembershipNotificationPort();
  const sm = new DepartmentApplicationStateMachine();
  const settleChange = new SettleRelationChangeCommand(relRepo, port, notify);
  const change = new ChangeDepartmentRelationCommand(relRepo, access, directory, notify);
  const submit = new SubmitDepartmentApplicationCommand(appRepo, access, directory, notify);
  const withdraw = new WithdrawDepartmentApplicationCommand(appRepo, notify);
  const decide = new DecideDepartmentApplicationCommand(appRepo, access, directory, notify);
  const executeApp = new ExecuteDepartmentApplicationCommand(
    appRepo,
    relRepo,
    settleChange,
    access,
    notify,
  );
  // 种子：leader1=社团负责人；hr1=人事；deptLeadD2=d2 部门负责人；stu1/stu2=当前成员（d1）
  access.seedOperator('c1', 'leader1', ['CLUB_LEADER']);
  access.seedOperator('c1', 'hr1', ['HR_ADMIN']);
  access.seedOperator('c1', 'deptLeadD2', ['DEPARTMENT_LEADER']);
  access.seedSubjectRole('c1', 'stu1', 'MEMBER');
  access.seedSubjectRole('c1', 'stu2', 'MEMBER');
  directory.seedMemberDepartments('c1', 'stu1', ['d1']);
  directory.seedMemberDepartments('c1', 'stu2', ['d1']);
  directory.seedDepartmentActive('c1', 'd1');
  directory.seedDepartmentActive('c1', 'd2');
  directory.seedDepartmentLeaders('c1', 'd2', ['deptLeadD2']);
  return {
    appRepo,
    relRepo,
    port,
    access,
    directory,
    notify,
    sm,
    change,
    settleChange,
    submit,
    withdraw,
    decide,
    executeApp,
  };
};

/** 建立 stu 在 d1 的当前有效关系段（作为退出/调动范围） */
async function seedValidDept(rig: Rig, subjectId: string, deptId: string): Promise<void> {
  rig.directory.seedMemberDepartments('c1', subjectId, [
    ...((await rig.directory.currentDepartmentIds('c1', subjectId)) ?? []),
  ]);
  const started = await rig.change.execute({
    clubId: 'c1',
    subjectId,
    operatorId: 'leader1',
    changeType: 'JOIN_DEPARTMENT',
    targetRefId: deptId,
  });
  const settled = await rig.settleChange.execute(started.groupId);
  assert.equal(settled.outcome, 'CONFIRMED');
}

describe('MEM-003 部门关系申请 · 状态机转换表', () => {
  it('全部 SRS §8.3 转换在表中声明；批准后关闭撤回能力', () => {
    const sm = new DepartmentApplicationStateMachine();
    assert.ok(sm.canTransition('PENDING_APPROVAL', 'WITHDRAWN'));
    assert.ok(sm.canTransition('PENDING_APPROVAL', 'REJECTED'));
    assert.ok(sm.canTransition('PENDING_APPROVAL', 'APPROVED_PENDING_EXECUTION'));
    assert.ok(sm.canTransition('APPROVED_PENDING_EXECUTION', 'EXECUTION_PROCESSING'));
    assert.ok(sm.canTransition('EXECUTION_PROCESSING', 'EFFECTIVE'));
    assert.ok(sm.canTransition('EXECUTION_PROCESSING', 'EXEC_FAILED_ORIGINAL_PRESERVED'));
    assert.ok(sm.canTransition('EXECUTION_PROCESSING', 'EXECUTION_PROCESSING')); // 自环保留
    assert.ok(sm.canTransition('EXEC_FAILED_ORIGINAL_PRESERVED', 'EXECUTION_PROCESSING')); // A8 重试
    assert.ok(!sm.canTransition('APPROVED_PENDING_EXECUTION', 'WITHDRAWN')); // 批准后关闭撤回
    assert.ok(!sm.canTransition('EFFECTIVE', 'EXECUTION_PROCESSING')); // 终态
    assert.ok(sm.canWithdraw('PENDING_APPROVAL'));
    assert.ok(!sm.canWithdraw('APPROVED_PENDING_EXECUTION'));
  });
});

describe('MEM-003 A1 提交申请（新建 → 待审批）', () => {
  it('成员本人提交加入申请：待审批＋角色型待办通知目标部门负责人（本人排除）', async () => {
    const rig = makeRig();
    const app = await rig.submit.execute({
      clubId: 'c1',
      applicantId: 'stu1',
      type: 'JOIN',
      targetDeptId: 'd2',
      reason: '希望加入技术部',
    });
    assert.equal(app.status, 'PENDING_APPROVAL');
    assert.equal(app.targetDeptId, 'd2');
    assert.deepEqual(app.leaveDeptIds, []);
    const facts = await rig.notify.list();
    const todo = facts.find((f) => f.kind === 'DEPT_APPLICATION_PENDING_APPROVAL');
    assert.ok(todo !== undefined);
    assert.ok(todo.toUserIds.includes('deptLeadD2'));
    assert.ok(!todo.toUserIds.includes('stu1')); // 本人从审批候选排除
    const ack = facts.find((f) => f.kind === 'DEPT_APPLICATION_SUBMITTED_ACK');
    assert.ok(ack !== undefined && ack.toUserIds.includes('stu1'));
  });

  it('部门无负责人时审批待办回退社团负责人/人事（ORG-036）', async () => {
    const rig = makeRig();
    rig.access.seedOwners('c1', ['leader1']);
    const app = await rig.submit.execute({
      clubId: 'c1',
      applicantId: 'stu1',
      type: 'LEAVE',
      leaveDeptIds: ['d1'], // d1 未播种部门负责人 → 回退社团负责人
    });
    const facts = await rig.notify.list();
    const todo = facts.find((f) => f.kind === 'DEPT_APPLICATION_PENDING_APPROVAL');
    assert.ok(todo !== undefined);
    assert.ok(todo.toUserIds.includes('leader1'));
    assert.ok(!todo.toUserIds.includes('stu1'));
    void app;
  });

  it('非成员提交被拒绝', async () => {
    const rig = makeRig();
    await assert.rejects(
      rig.submit.execute({
        clubId: 'c1',
        applicantId: 'stranger',
        type: 'JOIN',
        targetDeptId: 'd2',
      }),
      /IFC-ERR-006/,
    );
  });

  it('目标部门无效时拒绝；重复待审批唯一（冲突申请仅一个）', async () => {
    const rig = makeRig();
    // dDead 从未播种 → departmentActive 返回 false
    await assert.rejects(
      rig.submit.execute({
        clubId: 'c1',
        applicantId: 'stu1',
        type: 'JOIN',
        targetDeptId: 'dDead',
      }),
      /IFC-ERR-006/,
    );
    await rig.submit.execute({
      clubId: 'c1',
      applicantId: 'stu1',
      type: 'JOIN',
      targetDeptId: 'd2',
    });
    await assert.rejects(
      rig.submit.execute({
        clubId: 'c1',
        applicantId: 'stu1',
        type: 'JOIN',
        targetDeptId: 'd2',
      }),
      /IFC-ERR-006/,
    );
  });

  it('调动必须列出选择退出的原部门；退出范围越界拒绝', async () => {
    const rig = makeRig();
    await assert.rejects(
      rig.submit.execute({
        clubId: 'c1',
        applicantId: 'stu1',
        type: 'TRANSFER',
        targetDeptId: 'd2',
        leaveDeptIds: [],
      }),
      /IFC-ERR-006/,
    );
    await assert.rejects(
      rig.submit.execute({
        clubId: 'c1',
        applicantId: 'stu1',
        type: 'TRANSFER',
        targetDeptId: 'd2',
        leaveDeptIds: ['dNotJoined'],
      }),
      /IFC-ERR-006/,
    );
  });
});

describe('MEM-003 A2 撤回（待审批 → 已撤回）', () => {
  async function submitJoin(rig: Rig) {
    return rig.submit.execute({
      clubId: 'c1',
      applicantId: 'stu1',
      type: 'JOIN',
      targetDeptId: 'd2',
    });
  }

  it('本人二次确认撤回成功；不改变当前关系', async () => {
    const rig = makeRig();
    const app = await submitJoin(rig);
    const withdrawn = await rig.withdraw.execute({
      applicationId: app.applicationId,
      operatorId: 'stu1',
      secondConfirmed: true,
    });
    assert.equal(withdrawn.status, 'WITHDRAWN');
  });

  it('未二次确认或非本人撤回均拒绝', async () => {
    const rig = makeRig();
    const app = await submitJoin(rig);
    await assert.rejects(
      rig.withdraw.execute({
        applicationId: app.applicationId,
        operatorId: 'stu1',
        secondConfirmed: false,
      }),
      /IFC-ERR-006/,
    );
    await assert.rejects(
      rig.withdraw.execute({
        applicationId: app.applicationId,
        operatorId: 'leader1',
        secondConfirmed: true,
      }),
      /IFC-ERR-003/,
    );
  });

  it('与批准并发竞争只一个成功：撤回失败提示状态已变化', async () => {
    const rig = makeRig();
    const app = await submitJoin(rig);
    // 先批准（消耗版本），再以过期快照撤回 → compareAndSwap 失败
    await rig.decide.execute({
      applicationId: app.applicationId,
      operatorId: 'deptLeadD2',
      decision: 'APPROVE',
    });
    await assert.rejects(
      rig.withdraw.execute({
        applicationId: app.applicationId,
        operatorId: 'stu1',
        secondConfirmed: true,
      }),
      (err: Error) => /IFC-ERR-007/.test(err.message),
    );
  });
});

describe('MEM-003 A3/A4 审批（驳回/批准）', () => {
  async function submitJoin(rig: Rig) {
    return rig.submit.execute({
      clubId: 'c1',
      applicantId: 'stu1',
      type: 'JOIN',
      targetDeptId: 'd2',
    });
  }

  it('申请人本人不能审批自己（自审排除 ORG-036）', async () => {
    const rig = makeRig();
    const app = await submitJoin(rig);
    rig.access.seedOperator('c1', 'stu1', ['CLUB_LEADER']);
    await assert.rejects(
      rig.decide.execute({
        applicationId: app.applicationId,
        operatorId: 'stu1',
        decision: 'APPROVE',
      }),
      /IFC-ERR-003/,
    );
  });

  it('无权者拒绝：部门负责人仅本部门目标申请；其他部门负责人无权', async () => {
    const rig = makeRig();
    rig.access.seedOperator('c1', 'deptLeadOther', ['DEPARTMENT_LEADER']);
    rig.directory.seedDepartmentLeaders('c1', 'dOther', ['deptLeadOther']);
    const app = await submitJoin(rig); // 目标 d2
    await assert.rejects(
      rig.decide.execute({
        applicationId: app.applicationId,
        operatorId: 'deptLeadOther',
        decision: 'APPROVE',
      }),
      /IFC-ERR-003/,
    );
  });

  it('驳回必须填写原因；驳回后通知本人并留痕', async () => {
    const rig = makeRig();
    const app = await submitJoin(rig);
    await assert.rejects(
      rig.decide.execute({
        applicationId: app.applicationId,
        operatorId: 'deptLeadD2',
        decision: 'REJECT',
      }),
      /IFC-ERR-006/,
    );
    const rejected = await rig.decide.execute({
      applicationId: app.applicationId,
      operatorId: 'deptLeadD2',
      decision: 'REJECT',
      rejectReason: '本部门编制已满',
    });
    assert.equal(rejected.status, 'REJECTED');
    assert.equal(rejected.approval?.rejectReason, '本部门编制已满');
    const facts = await rig.notify.list();
    assert.ok(
      facts.some((f) => f.kind === 'DEPT_APPLICATION_REJECTED' && f.toUserIds.includes('stu1')),
    );
  });

  it('批准进入已批准待执行：保存审批人角色，关闭撤回能力', async () => {
    const rig = makeRig();
    const app = await submitJoin(rig);
    const approved = await rig.decide.execute({
      applicationId: app.applicationId,
      operatorId: 'deptLeadD2',
      decision: 'APPROVE',
    });
    assert.equal(approved.status, 'APPROVED_PENDING_EXECUTION');
    assert.equal(approved.approval?.decidedByRole, 'DEPARTMENT_LEADER');
    await assert.rejects(
      rig.withdraw.execute({
        applicationId: app.applicationId,
        operatorId: 'stu1',
        secondConfirmed: true,
      }),
      /IFC-ERR-007/,
    );
  });

  it('批准前目标失效或关系已变化时拒绝并保持待审批', async () => {
    const rig = makeRig();
    const app = await rig.submit.execute({
      clubId: 'c1',
      applicantId: 'stu1',
      type: 'TRANSFER',
      targetDeptId: 'd2',
      leaveDeptIds: ['d1'],
    });
    // 申请人已不在 d1：批准复核发现关系变化
    rig.directory.seedMemberDepartments('c1', 'stu1', []);
    await assert.rejects(
      rig.decide.execute({
        applicationId: app.applicationId,
        operatorId: 'leader1',
        decision: 'APPROVE',
      }),
      /IFC-ERR-006/,
    );
    const still = await rig.appRepo.load(app.applicationId);
    assert.equal(still?.status, 'PENDING_APPROVAL');
  });
});

describe('MEM-003 A5/A6 执行与生效（整体执行、全部确认才生效）', () => {
  it('加入申请：启动执行建关系段；回读全部确认后已生效且关系当前有效', async () => {
    const rig = makeRig();
    const app = await rig.submit.execute({
      clubId: 'c1',
      applicantId: 'stu1',
      type: 'JOIN',
      targetDeptId: 'd2',
    });
    await rig.decide.execute({
      applicationId: app.applicationId,
      operatorId: 'deptLeadD2',
      decision: 'APPROVE',
    });
    const done = await rig.executeApp.execute(app.applicationId, 'leader1');
    assert.equal(done.status, 'EFFECTIVE');
    assert.equal(done.execution?.attemptCount, 1);
    // 关系段已生效
    const rel = await rig.relRepo.listBySubjectAndRef('c1', 'stu1', 'd2');
    assert.equal(rel[0]?.status, 'CURRENTLY_VALID');
    const facts = await rig.notify.list();
    assert.ok(facts.some((f) => f.kind === 'DEPT_APPLICATION_EFFECTIVE'));
  });

  it('跨部门调动整体执行：新增侧与移出侧同组一次性落定（不得半完成）', async () => {
    const rig = makeRig();
    await seedValidDept(rig, 'stu2', 'd1');
    const app = await rig.submit.execute({
      clubId: 'c1',
      applicantId: 'stu2',
      type: 'TRANSFER',
      targetDeptId: 'd2',
      leaveDeptIds: ['d1'],
    });
    await rig.decide.execute({
      applicationId: app.applicationId,
      operatorId: 'deptLeadD2',
      decision: 'APPROVE',
    });
    const done = await rig.executeApp.execute(app.applicationId, 'leader1');
    assert.equal(done.status, 'EFFECTIVE');
    const newRel = await rig.relRepo.listBySubjectAndRef('c1', 'stu2', 'd2');
    const oldRel = await rig.relRepo.listBySubjectAndRef('c1', 'stu2', 'd1');
    assert.equal(newRel[0]?.status, 'CURRENTLY_VALID');
    assert.equal(oldRel[0]?.status, 'HISTORICAL_ENDED'); // 同组收口，不得半完成
    // 移出侧结束原因由结束决定（R4 endKind）推导，调动为 TRANSFER_OUT
    assert.equal(oldRel[0]?.endReason, 'TRANSFER_OUT');
  });

  it('纯退出申请：移出侧历史结束，结束原因记为退部（LEAVE_DEPARTMENT）而非调动移出', async () => {
    const rig = makeRig();
    await seedValidDept(rig, 'stu1', 'd1');
    const app = await rig.submit.execute({
      clubId: 'c1',
      applicantId: 'stu1',
      type: 'LEAVE',
      leaveDeptIds: ['d1'],
    });
    await rig.decide.execute({
      applicationId: app.applicationId,
      operatorId: 'leader1', // d1 无部门负责人 → 回退社团负责人
      decision: 'APPROVE',
    });
    const done = await rig.executeApp.execute(app.applicationId, 'leader1');
    assert.equal(done.status, 'EFFECTIVE');
    const rel = await rig.relRepo.listBySubjectAndRef('c1', 'stu1', 'd1');
    assert.equal(rel[0]?.status, 'HISTORICAL_ENDED');
    // 纯退出不应被硬编码误记为“调动移出”
    assert.equal(rel[0]?.endReason, 'LEAVE_DEPARTMENT');
  });

  it('无执行权限者不能启动执行；未批准不能执行', async () => {
    const rig = makeRig();
    rig.access.seedOperator('c1', 'pleb', ['MEMBER']);
    const app = await rig.submit.execute({
      clubId: 'c1',
      applicantId: 'stu1',
      type: 'JOIN',
      targetDeptId: 'd2',
    });
    await assert.rejects(rig.executeApp.execute(app.applicationId, 'pleb'), /IFC-ERR-00(3|7)/);
    await rig.decide.execute({
      applicationId: app.applicationId,
      operatorId: 'deptLeadD2',
      decision: 'APPROVE',
    });
    await assert.rejects(rig.executeApp.execute(app.applicationId, 'pleb'), /IFC-ERR-003/);
  });
});

describe('MEM-003 A7/A8 失败保持原关系与人工重试', () => {
  it('外部硬失败：补偿完成原关系保持 → 执行失败保持原关系（可人工重试）', async () => {
    const rig = makeRig(
      [[{ target: { kind: 'DEPARTMENT', refId: 'd2' }, ok: false, confirmed: false }]],
      [], // 补偿 removeAll 走默认确认
    );
    const app = await rig.submit.execute({
      clubId: 'c1',
      applicantId: 'stu1',
      type: 'JOIN',
      targetDeptId: 'd2',
    });
    await rig.decide.execute({
      applicationId: app.applicationId,
      operatorId: 'deptLeadD2',
      decision: 'APPROVE',
    });
    const failed = await rig.executeApp.execute(app.applicationId, 'leader1');
    assert.equal(failed.status, 'EXEC_FAILED_ORIGINAL_PRESERVED');
    // 关系段回到无关系（补偿完成，从未生效）
    const rel = await rig.relRepo.listBySubjectAndRef('c1', 'stu1', 'd2');
    assert.equal(rel[0]?.status, 'NO_RELATION');
  });

  it('人工重试沿用原批准与业务幂等键（新尝试号），不重新审批；成功后已生效', async () => {
    const failThenOk = makeRigWithRetryScenario();
    const { rig, app } = await failThenOk;
    // 首次执行后重新载入最新对象（首次尝试已落库）
    const firstFailed = await rig.appRepo.load(app.applicationId);
    assert.equal(firstFailed?.execution?.attemptCount, 1);
    assert.equal(firstFailed?.status, 'EXEC_FAILED_ORIGINAL_PRESERVED');
    const retried = await rig.executeApp.retry(app.applicationId, 'leader1');
    assert.equal(retried.status, 'EFFECTIVE');
    assert.equal(retried.execution?.attemptCount, 2);
    // 审批记录未被复制/重做：仍只有一次批准事实
    const approvals = retried.history.filter((h) => h.type === 'APPROVED');
    assert.equal(approvals.length, 1);
    const retries = retried.history.filter((h) => h.type === 'RETRY_STARTED');
    assert.equal(retries.length, 1);
    // 重试建立新段（旧补偿段保留为无关系历史），当前有效段须存在
    const rels = await rig.relRepo.listBySubjectAndRef('c1', 'stu1', 'd2');
    assert.ok(rels.some((r) => r.status === 'CURRENTLY_VALID'));
  });

  it('ANOMALY 结算：申请收口到失败保持原关系（可重试）；人工修复关系后重试直接收口生效', async () => {
    // 执行写入失败且补偿未确认 → ANOMALY，关系段转同步异常
    const rig = makeRig(
      [[{ target: { kind: 'DEPARTMENT', refId: 'd2' }, ok: false, confirmed: false }]],
      [[{ target: { kind: 'DEPARTMENT', refId: 'd2' }, ok: false, confirmed: false }]],
    );
    const app = await rig.submit.execute({
      clubId: 'c1',
      applicantId: 'stu1',
      type: 'JOIN',
      targetDeptId: 'd2',
    });
    await rig.decide.execute({
      applicationId: app.applicationId,
      operatorId: 'deptLeadD2',
      decision: 'APPROVE',
    });
    const failed = await rig.executeApp.execute(app.applicationId, 'leader1');
    // 不再卡死 EXECUTION_PROCESSING：ANOMALY 映射到失败保持原关系，可人工重试收口
    assert.equal(failed.status, 'EXEC_FAILED_ORIGINAL_PRESERVED');
    const segs = await rig.relRepo.listBySubjectAndRef('c1', 'stu1', 'd2');
    assert.equal(segs[0]?.status, 'SYNC_ANOMALY');

    // 人工通过 resolve-relation-anomaly 按 Casdoor 当前值修复关系段为当前有效
    const resolve = new ResolveRelationAnomalyCommand(
      rig.relRepo,
      rig.port,
      rig.access,
      rig.notify,
    );
    await resolve.execute({
      clubId: 'c1',
      relationId: segs[0].relationId,
      operatorId: 'leader1',
      resolution: 'CONFIRM_ACTIVE',
      riskReviewed: true,
    });

    // retry 时检测到目标关系已实际生效 → 直接收口生效，不重复执行
    const done = await rig.executeApp.retry(app.applicationId, 'leader1');
    assert.equal(done.status, 'EFFECTIVE');
    const relAfter = await rig.relRepo.listBySubjectAndRef('c1', 'stu1', 'd2');
    assert.ok(relAfter.some((r) => r.status === 'CURRENTLY_VALID'));
  });

  /** 第一次执行失败、随后队列恢复成功的夹具 */
  async function makeRigWithRetryScenario(): Promise<{
    rig: Rig;
    app: Awaited<ReturnType<Rig['submit']['execute']>>;
  }> {
    const rig = makeRig([
      [{ target: { kind: 'DEPARTMENT', refId: 'd2' }, ok: false, confirmed: false }],
    ]);
    const app = await rig.submit.execute({
      clubId: 'c1',
      applicantId: 'stu1',
      type: 'JOIN',
      targetDeptId: 'd2',
    });
    await rig.decide.execute({
      applicationId: app.applicationId,
      operatorId: 'deptLeadD2',
      decision: 'APPROVE',
    });
    await rig.executeApp.execute(app.applicationId, 'leader1');
    return { rig, app };
  }

  it('无权重试拒绝；非失败态重试拒绝', async () => {
    const rig = makeRig();
    rig.access.seedOperator('c1', 'pleb', ['MEMBER']);
    const app = await rig.submit.execute({
      clubId: 'c1',
      applicantId: 'stu1',
      type: 'JOIN',
      targetDeptId: 'd2',
    });
    await assert.rejects(
      rig.executeApp.retry(app.applicationId, 'pleb'),
      /IFC-ERR-003|IFC-ERR-007/,
    );
  });

  it('组 id 规则：幂等键基础＋尝试号（applicationGroupIdOf）', async () => {
    const rig = makeRig();
    const app = await rig.submit.execute({
      clubId: 'c1',
      applicantId: 'stu1',
      type: 'JOIN',
      targetDeptId: 'd2',
    });
    assert.equal(applicationGroupIdOf(app), null); // 未开始执行
  });
});
