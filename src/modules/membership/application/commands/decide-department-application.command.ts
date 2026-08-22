import { Inject, Injectable } from '@nestjs/common';

import type {
  DepartmentApplication,
  ApplicationApprovalState,
} from '../../domain/models/department-application';
import { DepartmentApplicationPolicy } from '../../domain/services/application-policy';
import { DepartmentApplicationStateMachine } from '../../domain/state-machines/department-application.state-machine';
import { DepartmentApplicationStatus } from '../../domain/state-machines/department-application.state-machine';
import { DEPARTMENT_APPLICATION_REPOSITORY } from '../../infrastructure/department-application-repository';
import type { DepartmentApplicationRepository } from '../../infrastructure/department-application-repository';
import { RELATION_DIRECTORY_PORT } from '../relation-ports';
import type { RelationDirectoryPort } from '../relation-ports';
import {
  MEMBERSHIP_ACCESS_PORT,
  MEMBERSHIP_NOTIFICATION_PORT,
  saveNotificationFact,
} from '../ports';
import type { MembershipAccessPort, MembershipNotificationPort } from '../ports';
import { InMemoryMembershipNotificationPort } from '../../infrastructure/in-memory-stubs';

/** 审批输入（A3 驳回 / A4 批准） */
export interface DecideDepartmentApplicationInput {
  readonly applicationId: string;
  readonly operatorId: string;
  readonly decision: 'APPROVE' | 'REJECT';
  /** 驳回原因（驳回必填） */
  readonly rejectReason?: string;
}

/** 审批失败（IFC-ERR-003/006/007） */
export class DecideApplicationError extends Error {
  constructor(
    readonly code: 'IFC-ERR-003' | 'IFC-ERR-006' | 'IFC-ERR-007',
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = 'DecideApplicationError';
  }
}

/**
 * 审批部门关系申请（A3/A4：待审批 → 已驳回 | 已批准待执行）。
 *
 * - 审批人＝对应部门负责人、社团负责人或人事管理员；部门负责人仅本部门目标申请；
 *   无部门负责人时回退社团负责人/人事（MEM-017、ORG-036）；
 * - 申请人本人不能审批自己（自审排除）；
 * - 驳回必须填写原因；批准后关闭撤回能力并创建关系执行准备；
 * - 与撤回/另一审批竞争只一个成功（版本比较交换）。
 */
@Injectable()
export class DecideDepartmentApplicationCommand {
  private readonly policy = new DepartmentApplicationPolicy();
  private readonly stateMachine = new DepartmentApplicationStateMachine();

  constructor(
    @Inject(DEPARTMENT_APPLICATION_REPOSITORY)
    private readonly repo: DepartmentApplicationRepository,
    @Inject(MEMBERSHIP_ACCESS_PORT) private readonly access: MembershipAccessPort,
    @Inject(RELATION_DIRECTORY_PORT) private readonly directory: RelationDirectoryPort,
    @Inject(MEMBERSHIP_NOTIFICATION_PORT)
    private readonly notifications: MembershipNotificationPort = new InMemoryMembershipNotificationPort(),
  ) {}

  async execute(input: DecideDepartmentApplicationInput): Promise<DepartmentApplication> {
    const app = await this.repo.load(input.applicationId);
    if (app === null) {
      throw new DecideApplicationError('IFC-ERR-006', '申请不存在');
    }
    if (app.status !== DepartmentApplicationStatus.PENDING_APPROVAL) {
      throw new DecideApplicationError('IFC-ERR-007', `当前状态 ${app.status} 不允许审批`);
    }

    // 自审排除（申请人本人从审批候选排除）
    this.policy.assertNotSelf(input.operatorId, app.applicantId);

    // 审批权门（服务端重算）：join/transfer → 目标＋退出部门负责人均可；
    // leave → 退出部门负责人
    const operatorRoles = await this.access.operatorRolesAt(app.clubId, input.operatorId);
    const relevantDepts =
      app.type === 'LEAVE'
        ? [...app.leaveDeptIds]
        : [app.targetDeptId, ...app.leaveDeptIds].filter((d): d is string => d !== null);
    const leaderUnion = new Set<string>();
    let anyDeptHasLeader = false;
    for (const deptId of relevantDepts) {
      const leaders = await this.directory.departmentLeaderIds(app.clubId, deptId);
      if (leaders.length > 0) {
        anyDeptHasLeader = true;
        for (const l of leaders) leaderUnion.add(l);
      }
    }
    this.policy.assertCanDecide({
      operatorRoles,
      operatorId: input.operatorId,
      applicantId: app.applicantId,
      operatorLeadsTargetDept: leaderUnion.has(input.operatorId),
      departmentHasLeader: anyDeptHasLeader,
    });

    if (input.decision === 'REJECT') {
      this.policy.assertRejectReason(input.rejectReason);
    }

    // 批准前复核：当前关系与目标仍满足（关系已变化或目标失效时拒绝，保持待审批）
    if (input.decision === 'APPROVE') {
      await this.assertTargetStillValid(app);
    }

    const nowIso = new Date().toISOString();
    const approval: ApplicationApprovalState = {
      decision: input.decision,
      decidedByRole: operatorRoles[0] ?? 'UNKNOWN',
      decidedBy: input.operatorId,
      decidedAt: nowIso,
      rejectReason: input.decision === 'REJECT' ? (input.rejectReason ?? null) : null,
    };
    const nextStatus =
      input.decision === 'APPROVE'
        ? DepartmentApplicationStatus.APPROVED_PENDING_EXECUTION
        : DepartmentApplicationStatus.REJECTED;
    const next: DepartmentApplication = {
      ...app,
      status: this.stateMachine.transition(app.status, nextStatus),
      version: app.version + 1,
      approval,
      execution:
        input.decision === 'APPROVE'
          ? {
              status: 'PENDING_START',
              idempotencyBase: `deptapp:${app.applicationId}`,
              attemptCount: 0,
            }
          : null,
      history: [
        ...app.history,
        {
          at: nowIso,
          type: input.decision === 'APPROVE' ? 'APPROVED' : 'REJECTED',
          by: input.operatorId,
          note: input.decision === 'REJECT' ? (input.rejectReason ?? '') : '批准，待执行',
        },
      ],
    };
    const swapped = await this.repo.compareAndSwap(app, next);
    if (!swapped) {
      throw new DecideApplicationError(
        'IFC-ERR-007',
        '申请状态已变化（与撤回/审批并发），请刷新后按实际状态操作',
      );
    }

    await saveNotificationFact(this.notifications, {
      kind:
        input.decision === 'APPROVE' ? 'DEPT_APPLICATION_APPROVED' : 'DEPT_APPLICATION_REJECTED',
      toUserIds: [app.applicantId],
      clubId: app.clubId,
      dedupKey: `DEPT_APPLICATION_DECIDED:${app.applicationId}:${next.version}`,
      title: input.decision === 'APPROVE' ? '申请已批准' : '申请已驳回',
      body:
        input.decision === 'APPROVE'
          ? '申请已批准，即将进入关系执行。'
          : `申请被驳回：${input.rejectReason ?? ''}`,
    });
    return next;
  }

  /** 批准前复核：目标部门仍有效；退出范围仍属于申请人当前部门 */
  private async assertTargetStillValid(app: DepartmentApplication): Promise<void> {
    if (app.type === 'JOIN' || app.type === 'TRANSFER') {
      const active =
        app.targetDeptId !== null
          ? await this.directory.departmentActive(app.clubId, app.targetDeptId)
          : false;
      if (!active) {
        throw new DecideApplicationError('IFC-ERR-006', '目标部门已失效，批准被拒绝（保持待审批）');
      }
    }
    const departmentIds = await this.directory.currentDepartmentIds(app.clubId, app.applicantId);
    for (const deptId of app.leaveDeptIds) {
      if (!departmentIds.includes(deptId)) {
        throw new DecideApplicationError(
          'IFC-ERR-006',
          '申请人当前部门关系已变化（不再包含退出范围），批准被拒绝',
        );
      }
    }
  }
}
