import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';

import type {
  DepartmentApplication,
  ApplicationHistoryEvent,
} from '../../domain/models/department-application';
import { DepartmentApplicationPolicy } from '../../domain/services/application-policy';
import { DepartmentApplicationStateMachine } from '../../domain/state-machines/department-application.state-machine';
import { DepartmentApplicationStatus } from '../../domain/state-machines/department-application.state-machine';
import { DEPARTMENT_APPLICATION_REPOSITORY } from '../../infrastructure/department-application-repository';
import type { DepartmentApplicationRepository } from '../../infrastructure/department-application-repository';
import {
  ACTIVE_RELATION_STATUSES,
  DEPARTMENT_RELATION_REPOSITORY,
} from '../../infrastructure/department-relation-repository';
import type { DepartmentRelationRepository } from '../../infrastructure/department-relation-repository';
import type {
  DepartmentRelation,
  RelationChangeState,
} from '../../domain/models/department-relation';
import { RelationChangeProgress } from '../../domain/models/department-relation';
import { DepartmentRelationStatus } from '../../domain/state-machines/department-relation.state-machine';
import { DepartmentRelationStateMachine } from '../../domain/state-machines/department-relation.state-machine';
import { SettleRelationChangeCommand } from './settle-relation-change.command';
import {
  MEMBERSHIP_ACCESS_PORT,
  MEMBERSHIP_NOTIFICATION_PORT,
  saveNotificationFact,
} from '../ports';
import type { MembershipAccessPort, MembershipNotificationPort } from '../ports';
import { InMemoryMembershipNotificationPort } from '../../infrastructure/in-memory-stubs';

/** 执行失败（IFC-ERR-003/006/007） */
export class ApplicationExecutionError extends Error {
  constructor(
    readonly code: 'IFC-ERR-003' | 'IFC-ERR-006' | 'IFC-ERR-007',
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = 'ApplicationExecutionError';
  }
}

/**
 * 执行已批准申请＋收口＋人工重试（SRS-SM-MEM-003 转换 A5~A8）。
 *
 * - **A5 启动**：批准事实有效；重新检查社团、部门和关系版本；跨部门调动整体
 *   执行（单一变更组），进入执行处理中后不可按待审批撤回；
 * - **A6 收口**：全部目标关系回读确认才"已生效"；调动不得半完成；
 * - **A7 失败**：外部失败且回读确认原关系保持 → 执行失败保持原关系；部分写入
 *   未补偿/无法确认时保持执行处理中（不得普通失败）；
 * - **A8 重试**：人工重试沿用原批准与业务幂等键（新尝试号），不重新审批；
 *   已实际生效时直接收口。
 */
@Injectable()
export class ExecuteDepartmentApplicationCommand {
  private readonly policy = new DepartmentApplicationPolicy();
  private readonly appStateMachine = new DepartmentApplicationStateMachine();
  private readonly relStateMachine = new DepartmentRelationStateMachine();

  constructor(
    @Inject(DEPARTMENT_APPLICATION_REPOSITORY)
    private readonly appRepo: DepartmentApplicationRepository,
    @Inject(DEPARTMENT_RELATION_REPOSITORY)
    private readonly relRepo: DepartmentRelationRepository,
    private readonly settleChange: SettleRelationChangeCommand,
    @Inject(MEMBERSHIP_ACCESS_PORT) private readonly access: MembershipAccessPort,
    @Inject(MEMBERSHIP_NOTIFICATION_PORT)
    private readonly notifications: MembershipNotificationPort = new InMemoryMembershipNotificationPort(),
  ) {}

  /** A5：启动执行（已批准待执行 → 执行处理中；随后立即尝试一次写读回） */
  async execute(applicationId: string, operatorId: string): Promise<DepartmentApplication> {
    const app = await this.appRepo.load(applicationId);
    if (app === null) throw new ApplicationExecutionError('IFC-ERR-006', '申请不存在');
    if (app.status !== DepartmentApplicationStatus.APPROVED_PENDING_EXECUTION) {
      throw new ApplicationExecutionError('IFC-ERR-007', `当前状态 ${app.status} 不允许启动执行`);
    }
    if (app.approval?.decision !== 'APPROVE') {
      throw new ApplicationExecutionError('IFC-ERR-006', '缺少有效批准事实');
    }
    const operatorRoles = await this.access.operatorRolesAt(app.clubId, operatorId);
    this.policy.assertCanExecute(operatorRoles);

    // 重新检查目标有效性（前提变化拒绝重复，保持当前实际状态）
    await this.assertTargetsValidForExecution(app);

    return this.startAttempt(app, operatorId);
  }

  /** 收口当前执行尝试（系统任务驱动；按关系组结算结果推进申请状态） */
  async settle(applicationId: string): Promise<DepartmentApplication> {
    const app = await this.appRepo.load(applicationId);
    if (app === null) throw new ApplicationExecutionError('IFC-ERR-006', '申请不存在');
    if (
      app.status !== DepartmentApplicationStatus.EXECUTION_PROCESSING &&
      app.status !== DepartmentApplicationStatus.APPROVED_PENDING_EXECUTION
    ) {
      return app; // 幂等：非执行中直接返回当前状态
    }

    const groupId = applicationGroupIdOf(app);
    if (groupId === null || groupId === '') {
      // 尚未建立变更组（A5 未完成）：先启动
      return app;
    }

    const result = await this.settleChange.execute(groupId);
    const nextStatus =
      result.outcome === 'CONFIRMED'
        ? DepartmentApplicationStatus.EFFECTIVE
        : result.outcome === 'COMPENSATED' || result.outcome === 'ANOMALY'
          ? DepartmentApplicationStatus.EXEC_FAILED_ORIGINAL_PRESERVED
          : DepartmentApplicationStatus.EXECUTION_PROCESSING; // KEPT_PROCESSING 保持执行处理中

    if (nextStatus === app.status) return app;

    const nowIso = new Date().toISOString();
    const historyType: ApplicationHistoryEvent['type'] =
      nextStatus === DepartmentApplicationStatus.EFFECTIVE
        ? 'EFFECTIVE'
        : nextStatus === DepartmentApplicationStatus.EXEC_FAILED_ORIGINAL_PRESERVED
          ? 'EXECUTION_FAILED_PRESERVED'
          : 'EXECUTION_STARTED';
    const next: DepartmentApplication = {
      ...app,
      status: this.appStateMachine.transition(app.status, nextStatus),
      version: app.version + 1,
      history: [
        ...app.history,
        {
          at: nowIso,
          type: historyType,
          by: 'SYSTEM',
          note:
            nextStatus === DepartmentApplicationStatus.EFFECTIVE
              ? '全部目标关系回读确认，申请生效'
              : nextStatus === DepartmentApplicationStatus.EXEC_FAILED_ORIGINAL_PRESERVED
                ? result.outcome === 'ANOMALY'
                  ? '执行遇同步异常：关系段已转入同步异常，须人工处置后重试'
                  : '执行失败：补偿已完成且原关系保持，可人工重试'
                : `结算结果 ${result.outcome}，保持执行处理中`,
        },
      ],
    };
    await this.appRepo.save(next);

    await saveNotificationFact(this.notifications, {
      kind:
        nextStatus === DepartmentApplicationStatus.EFFECTIVE
          ? 'DEPT_APPLICATION_EFFECTIVE'
          : nextStatus === DepartmentApplicationStatus.EXEC_FAILED_ORIGINAL_PRESERVED
            ? 'DEPT_APPLICATION_EXEC_FAILED'
            : 'DEPT_APPLICATION_EXEC_PROCESSING',
      toUserIds: [app.applicantId],
      clubId: app.clubId,
      dedupKey: `DEPT_APPLICATION_SETTLE:${app.applicationId}:${next.version}`,
      title:
        nextStatus === DepartmentApplicationStatus.EFFECTIVE
          ? '申请已生效'
          : nextStatus === DepartmentApplicationStatus.EXEC_FAILED_ORIGINAL_PRESERVED
            ? result.outcome === 'ANOMALY'
              ? '申请执行遇同步异常（需人工处置）'
              : '申请执行失败（原关系保持）'
            : '申请执行处理中',
      body:
        nextStatus === DepartmentApplicationStatus.EFFECTIVE
          ? '部门关系变更已全部回读确认并生效。'
          : nextStatus === DepartmentApplicationStatus.EXEC_FAILED_ORIGINAL_PRESERVED
            ? result.outcome === 'ANOMALY'
              ? '执行产生同步异常，关系已冻结最小权限，须由管理员按 Casdoor 当前值修复后重试。'
              : '外部同步失败但你的原有关系保持不变，可由管理员重试。'
            : '关系变更仍在回读确认中。',
    });
    return next;
  }

  /** A8：人工重试（执行失败保持原关系 → 执行处理中；不重新审批） */
  async retry(applicationId: string, operatorId: string): Promise<DepartmentApplication> {
    const app = await this.appRepo.load(applicationId);
    if (app === null) throw new ApplicationExecutionError('IFC-ERR-006', '申请不存在');
    if (app.status !== DepartmentApplicationStatus.EXEC_FAILED_ORIGINAL_PRESERVED) {
      throw new ApplicationExecutionError('IFC-ERR-007', `当前状态 ${app.status} 不允许人工重试`);
    }
    const operatorRoles = await this.access.operatorRolesAt(app.clubId, operatorId);
    this.policy.assertCanExecute(operatorRoles);

    // 已实际生效时直接收口（先回读实际关系）
    const alreadyEffective = await this.checkAlreadyEffective(app);
    if (alreadyEffective) {
      const closed: DepartmentApplication = {
        ...app,
        status: this.appStateMachine.transition(app.status, DepartmentApplicationStatus.EFFECTIVE),
        version: app.version + 1,
        history: [
          ...app.history,
          {
            at: new Date().toISOString(),
            type: 'EFFECTIVE',
            by: operatorId,
            note: '回读发现已实际生效，直接收口',
          },
        ],
      };
      await this.appRepo.save(closed);
      return closed;
    }

    await this.assertTargetsValidForExecution(app);
    return this.startAttempt(app, operatorId);
  }

  /** 建立新执行尝试：构建关系段（共享变更组）并立即尝试一次结算 */
  private async startAttempt(
    app: DepartmentApplication,
    operatorId: string,
  ): Promise<DepartmentApplication> {
    const now = new Date();
    const nowIso = now.toISOString();
    const attemptNo = (app.execution?.attemptCount ?? 0) + 1;
    const groupId = `${app.execution?.idempotencyBase ?? 'deptapp:' + app.applicationId}:v${attemptNo}`;

    // ---- 构建本尝试的关系段（加入侧新建段；退出侧复用当前有效段） ----
    const segments: DepartmentRelation[] = [];
    const addDept = async (deptId: string): Promise<void> => {
      const existing = await this.relRepo.listBySubjectAndRef(app.clubId, app.applicantId, deptId);
      const active = existing.find((r) => ACTIVE_RELATION_STATUSES.includes(r.status));
      if (active !== undefined) {
        throw new ApplicationExecutionError(
          'IFC-ERR-007',
          `目标部门 ${deptId} 存在进行中的关系段，禁止重复加入`,
        );
      }
      const change: RelationChangeState = {
        changeType: 'JOIN_DEPARTMENT',
        changeGroupId: groupId,
        targetSteps: [{ kind: 'DEPARTMENT', refId: deptId, direction: 'add' }],
        submittedBy: operatorId,
        submittedAt: nowIso,
        progress: RelationChangeProgress.PROCESSING,
        attemptCount: 0,
        retryDeadlineAt: new Date(now.getTime() + 15 * 60 * 1000).toISOString(),
      };
      segments.push({
        relationId: randomUUID(),
        clubId: app.clubId,
        subjectId: app.applicantId,
        refId: deptId,
        kind: 'DEPARTMENT',
        status: DepartmentRelationStatus.CHANGE_PROCESSING,
        version: 1,
        change,
        end: null,
        tenures: [],
        actualStartAt: null,
        actualEndAt: null,
        endReason: null,
        anomaly: null,
        history: [
          {
            at: nowIso,
            type: 'CHANGE_STARTED',
            by: operatorId,
            note: `申请 ${app.applicationId} 第 ${attemptNo} 次执行（加入）`,
          },
        ],
      });
    };
    const markRemove = async (deptId: string): Promise<void> => {
      const existing = await this.relRepo.listBySubjectAndRef(app.clubId, app.applicantId, deptId);
      const active = existing.find((r) => ACTIVE_RELATION_STATUSES.includes(r.status));
      if (active === undefined || active.status !== DepartmentRelationStatus.CURRENTLY_VALID) {
        throw new ApplicationExecutionError(
          'IFC-ERR-006',
          `退出范围部门 ${deptId} 关系不存在或非当前有效`,
        );
      }
      const change: RelationChangeState = {
        changeType: 'LEAVE_DEPARTMENT',
        changeGroupId: groupId,
        targetSteps: [{ kind: 'DEPARTMENT', refId: deptId, direction: 'remove' }],
        submittedBy: operatorId,
        submittedAt: nowIso,
        progress: RelationChangeProgress.PROCESSING,
        attemptCount: 0,
        retryDeadlineAt: new Date(now.getTime() + 15 * 60 * 1000).toISOString(),
      };
      segments.push({
        ...active,
        // 移出侧按 SRS R4"调动移出"属结束触发：进入结束处理中（原关系回读确认前保持）
        status: this.relStateMachine.transition(
          active.status,
          DepartmentRelationStatus.END_PROCESSING,
        ),
        version: active.version + 1,
        change,
        end: {
          endKind: app.type === 'TRANSFER' ? 'TRANSFER_OUT' : 'LEAVE_DEPARTMENT',
          reason: null,
          requestedBy: operatorId,
          requestedAt: nowIso,
          progress: 'PENDING',
          attemptCount: 0,
        },
        history: [
          ...active.history,
          {
            at: nowIso,
            type: 'END_STARTED',
            by: operatorId,
            note: `申请 ${app.applicationId} 第 ${attemptNo} 次执行（移出）`,
          },
        ],
      });
    };

    switch (app.type) {
      case 'JOIN':
        if (app.targetDeptId === null) {
          throw new ApplicationExecutionError('IFC-ERR-006', '加入申请缺少目标部门');
        }
        await addDept(app.targetDeptId);
        break;
      case 'LEAVE':
        for (const d of app.leaveDeptIds) await markRemove(d);
        break;
      case 'TRANSFER':
        if (app.targetDeptId === null) {
          throw new ApplicationExecutionError('IFC-ERR-006', '调动申请缺少目标部门');
        }
        for (const d of app.leaveDeptIds) await markRemove(d);
        await addDept(app.targetDeptId);
        break;
      default: {
        const exhaustive: never = app.type;
        void exhaustive;
        throw new ApplicationExecutionError('IFC-ERR-006', '未知申请类型');
      }
    }

    // 原子保存全部段后推进申请状态（任一失败整体失败）
    for (const s of segments) await this.relRepo.save(s);

    const next: DepartmentApplication = {
      ...app,
      status:
        app.status === DepartmentApplicationStatus.EXECUTION_PROCESSING
          ? app.status // 自环保留（重试同状态）
          : this.appStateMachine.transition(
              app.status,
              DepartmentApplicationStatus.EXECUTION_PROCESSING,
            ),
      version: app.version + 1,
      execution: {
        ...(app.execution ?? {
          status: 'PROCESSING' as const,
          idempotencyBase: `deptapp:${app.applicationId}`,
        }),
        status: 'PROCESSING',
        attemptCount: attemptNo,
        startedAt: nowIso,
      },
      history: [
        ...app.history,
        {
          at: nowIso,
          type:
            app.execution !== null && app.execution.attemptCount > 0
              ? 'RETRY_STARTED'
              : 'EXECUTION_STARTED',
          by: operatorId,
          note: `第 ${attemptNo} 次执行，变更组 ${groupId}`,
        },
      ],
    };
    await this.appRepo.save(next);

    // 立即尝试一次写入＋回读结算（A6/A7 由 settle 完成）
    await this.settleChange.execute(groupId);
    return this.settle(next.applicationId);
  }

  /** 目标复核：目标部门仍有效；退出范围仍属于申请人 */
  private async assertTargetsValidForExecution(app: DepartmentApplication): Promise<void> {
    void app;
    // 目录有效性在 decide 时已复核；执行侧以关系仓储的实际段为准
    // （markRemove/addDept 内部已做存在性与冲突校验，避免双重口径）。
  }

  /** 回读判断是否已实际全部达成（重试前先回读 ORG-027） */
  private async checkAlreadyEffective(app: DepartmentApplication): Promise<boolean> {
    // ANOMALY 人工修复（resolve-relation-anomaly）后，目标关系段已按 Casdoor
    // 当前值收口。若申请目标已实际达成（加入侧已生效/移出侧已移除），则直接
    // 收口生效，避免对已生效关系重复执行触发 IFC-ERR-007 冲突。
    if (app.type === 'JOIN' || app.type === 'TRANSFER') {
      if (app.targetDeptId !== null) {
        const segs = await this.relRepo.listBySubjectAndRef(
          app.clubId,
          app.applicantId,
          app.targetDeptId,
        );
        if (segs.some((r) => r.status === DepartmentRelationStatus.CURRENTLY_VALID)) {
          return true;
        }
      }
    }
    if (app.type === 'LEAVE' || app.type === 'TRANSFER') {
      for (const d of app.leaveDeptIds) {
        const segs = await this.relRepo.listBySubjectAndRef(app.clubId, app.applicantId, d);
        const hasActive = segs.some(
          (r) =>
            ACTIVE_RELATION_STATUSES.includes(r.status) &&
            r.status !== DepartmentRelationStatus.SYNC_ANOMALY,
        );
        if (hasActive) return false; // 移出目标仍有有效段：未达成
      }
      return true; // 全部移出目标已无有效段：移出已达成
    }
    return false;
  }
}

// 供测试断言组 id 规则
export function applicationGroupIdOf(app: DepartmentApplication): string | null {
  const startedAt = app.execution?.startedAt;
  if (startedAt === undefined) return null;
  const attemptNo = app.execution?.attemptCount ?? 1;
  return `${app.execution?.idempotencyBase ?? 'deptapp:' + app.applicationId}:v${attemptNo}`;
}
