/**
 * SRS-SM-ORG-003 预约管理命令状态机（13 条转换；IFC-SM-006）。
 *
 * 权威语义：docs/specification/SRS-状态机转换明细-v1.0.md §4.3。
 *
 * 关键语义：
 * - 原命令内容不可改写；内容变化只能取消后新建（ORG-039）。
 * - 调度执行与取消以同一命令版本＋执行租约竞争，只允许一个成功（单执行租约）。
 * - 发起人失权 → 暂停待重新确认；业务前置条件失效 → 暂停待处置；
 *   条件恢复后只能按原内容重新确认（新执行时间）或取消（ORG-039）。
 * - 执行中/已生效后拒绝通用取消。
 */

import type { AppointmentCommand } from '../models/appointment-command';
import type { AppointmentCommandStatus } from '../types';
import { orgError } from '../types';

export type AppointmentEvent =
  | 'create'
  | 'schedule_execute'
  | 'initiator_revoked'
  | 'precondition_invalid'
  | 'reconfirm'
  | 'cancel'
  | 'execution_succeeded'
  | 'execution_failed'
  | 'retry_execute';

export interface AppointmentTransitionInput {
  command: AppointmentCommand;
  event: AppointmentEvent;
  now: Date;
  actor: string;
  /** 操作者在该社团的主角色（GOV-007：仅用于审计，不用于授权） */
  actorRole: string;
  facts: {
    /** 到达计划/新执行时间（调度幂等） */
    due?: boolean;
    /** 原发起人当前是否仍具执行原内容所需权限（ORG-039） */
    initiatorHasRights?: boolean;
    /** 逐项业务前置条件（账号/成员/组合任职资格/部门/职位/目标关系/连续性/对象状态） */
    preconditions?: ReadonlyArray<{ name: string; ok: boolean }>;
    /** 通用取消的操作者权限快照 */
    cancellerAuthorized?: boolean;
    /** 重新确认者权限 */
    confirmerAuthorized?: boolean;
    /** 新的合法执行时间（重新确认时提供） */
    newExecTime?: string;
    /** 执行失败/成功结果 */
    executionResult?: 'success' | 'failure';
    reason?: string;
  };
}

export interface AppointmentTransitionResult {
  command: AppointmentCommand;
  readonly requiredSideEffects: string[];
}

export class AppointmentCommandStateMachine {
  static readonly TABLE: Readonly<Record<AppointmentEvent, readonly AppointmentCommandStatus[]>> = {
    create: ['created'],
    schedule_execute: ['pending_execution', 'reconfirmed_pending_execution'],
    initiator_revoked: ['pending_execution', 'reconfirmed_pending_execution'],
    precondition_invalid: ['pending_execution', 'reconfirmed_pending_execution'],
    reconfirm: ['initiator_revoked_pending_reconfirm', 'precondition_invalid_pending_resolution'],
    cancel: [
      'pending_execution',
      'initiator_revoked_pending_reconfirm',
      'precondition_invalid_pending_resolution',
    ],
    execution_succeeded: ['executing'],
    execution_failed: ['executing'],
    retry_execute: ['exec_failed_pending_retry'],
  };

  private allowedFrom(event: AppointmentEvent, status: AppointmentCommandStatus): boolean {
    return AppointmentCommandStateMachine.TABLE[event].includes(status);
  }

  transition(input: AppointmentTransitionInput): AppointmentTransitionResult {
    const { command: original, event, now, actor, actorRole, facts } = input;
    const stamp = now.toISOString();

    if (!this.allowedFrom(event, original.status)) {
      throw orgError.stateConflict(
        `预约命令当前状态 ${original.status} 不允许执行 ${event}（IFC-ERR-007）`,
      );
    }

    const command: AppointmentCommand = { ...original };
    let sideEffects: string[] = [];
    const allPreconditionsOk = (facts.preconditions ?? []).every((p) => p.ok !== false);

    switch (event) {
      case 'create': {
        if (original.status !== 'created') {
          throw orgError.stateConflict('预约命令已创建，不得重复创建（IFC-ERR-007）');
        }
        command.status = 'pending_execution';
        command.scheduleVersion += 1;
        sideEffects = ['save_immutable_original', 'notify_affected', 'critical_audit'];
        break;
      }

      case 'schedule_execute': {
        if (facts.due !== true) {
          throw orgError.precondition('尚未到达执行时间（ORG-039）');
        }
        if (facts.initiatorHasRights === false) {
          // 仅发起人失权 → 暂停待重新确认（IFC-ERR-007 保持实际状态）
          command.status = 'initiator_revoked_pending_reconfirm';
          command.revokedEvidence = stamp;
          sideEffects = ['pause_execution', 'save_revocation_evidence', 'notify_current_admins'];
          break;
        }
        if (!allPreconditionsOk) {
          command.status = 'precondition_invalid_pending_resolution';
          command.preconditionSnapshot = facts.preconditions ?? [];
          sideEffects = [
            'save_precondition_snapshot',
            'close_schedule_eligibility',
            'notify_affected_admins',
            'status_audit',
          ];
          break;
        }
        command.status = 'executing';
        command.executionLease = actor;
        command.scheduleVersion += 1;
        sideEffects = [
          'lock_command',
          'create_relation_execution_task',
          'audit_permission_snapshot',
        ];
        break;
      }

      case 'initiator_revoked': {
        if (facts.initiatorHasRights !== false) {
          throw orgError.precondition('权限仍有效时不得进入失权暂停（ORG-039）');
        }
        command.status = 'initiator_revoked_pending_reconfirm';
        command.revokedEvidence = stamp;
        sideEffects = ['pause_execution', 'save_revocation_evidence', 'notify_current_admins'];
        break;
      }

      case 'precondition_invalid': {
        if (facts.initiatorHasRights === false) {
          throw orgError.precondition('发起/确认人失权时进入失权暂停，而非前置失效暂停（ORG-039）');
        }
        if (allPreconditionsOk) {
          throw orgError.precondition('全部业务前置条件仍成立，按正常执行（ORG-039）');
        }
        command.status = 'precondition_invalid_pending_resolution';
        command.preconditionSnapshot = facts.preconditions ?? [];
        sideEffects = [
          'save_precondition_snapshot',
          'close_schedule_eligibility',
          'notify_affected_admins',
        ];
        break;
      }

      case 'reconfirm': {
        if (facts.confirmerAuthorized !== true) {
          throw orgError.forbidden('重新确认者无权处理该命令（ORG-039）');
        }
        if (original.status === 'precondition_invalid_pending_resolution' && !allPreconditionsOk) {
          throw orgError.precondition('条件未恢复，不得重新确认（ORG-039）');
        }
        const nextExec =
          facts.newExecTime ??
          (original.status === 'initiator_revoked_pending_reconfirm'
            ? original.plannedAt
            : undefined);
        if (nextExec === undefined) {
          throw orgError.validation('重新确认须提交新的合法执行时间');
        }
        command.status = 'reconfirmed_pending_execution';
        command.confirmedBy = actor;
        command.newExecTime = nextExec;
        command.scheduleVersion += 1; // 旧调度任务永久失效（ORG-039）
        command.reconfirmations = [
          ...original.reconfirmations,
          { by: actor, role: actorRole, at: stamp },
        ];
        sideEffects = ['save_confirmation', 'invalidate_old_schedule', 'notify_affected'];
        break;
      }

      case 'cancel': {
        if (facts.cancellerAuthorized !== true) {
          throw orgError.forbidden('取消者无权取消该预约命令（ORG-039）');
        }
        command.status = 'cancelled';
        command.cancelledAt = stamp;
        command.cancelReason = facts.reason ?? '';
        command.cancelledBy = actor;
        sideEffects = [
          'save_cancel_audit',
          'notify_affected',
          'preserve_original_history',
          'status_audit',
        ];
        break;
      }

      case 'execution_succeeded': {
        if (facts.executionResult !== 'success') {
          throw orgError.externalUnknown('未回读确认时保持执行中（IFC-ERR-013）');
        }
        command.status = 'effective';
        command.actualEffectiveAt = stamp;
        command.executionLease = null;
        sideEffects = ['record_effective_time', 'write_relation_history', 'notify_subject_admins'];
        break;
      }

      case 'execution_failed': {
        if (facts.executionResult !== 'failure') {
          throw orgError.precondition('仅外部失败才进入执行失败待重试');
        }
        command.status = 'exec_failed_pending_retry';
        command.failureAttempts = [
          ...original.failureAttempts,
          { at: stamp, reason: facts.reason ?? '外部失败' },
        ];
        sideEffects = ['keep_original_relation', 'notify_initiator_admin', 'failure_audit'];
        break;
      }

      case 'retry_execute': {
        if (facts.confirmerAuthorized !== true) {
          throw orgError.forbidden('人工重试前须重新鉴权（ORG-039）');
        }
        command.status = 'executing';
        command.executionLease = actor;
        command.scheduleVersion += 1;
        sideEffects = ['create_new_attempt', 'audit_new_operator'];
        break;
      }

      default: {
        const exhaustive: never = event;
        throw orgError.stateConflict(`未支持的事件 ${String(exhaustive)}（IFC-ERR-007）`);
      }
    }

    return { command, requiredSideEffects: sideEffects };
  }
}
