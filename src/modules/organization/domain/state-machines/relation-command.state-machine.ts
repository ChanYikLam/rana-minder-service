/**
 * SRS-SM-ORG-002 Group 关系命令状态机（8 条转换；IFC-SM-005）。
 *
 * 权威语义：docs/specification/SRS-状态机转换明细-v1.0.md §4.2。
 *
 * 关键语义：
 * - 处理中：原关系/原权限继续有效；只有回读确认全部目标后才正式生效（ORG-027）。
 * - 响应不确定先回读再重试；自动重试最长 15 分钟；超时未确认 → 失败保持原状态，
 *   允许人工重试（重新鉴权 + 重读实际关系）。
 * - 复合部分成功必须按领域规则逆序补偿；补偿未确认前不得授予新增权限
 *   （ORG-027、ORG-034、MEM-007/009/018）。
 */

import type { RelationCommand } from '../models/relation-command';
import type { RelationCommandStatus, RelationWriteStep } from '../types';
import { orgError } from '../types';

export type RelationEvent =
  | 'submit'
  | 'write_started'
  | 'readback_confirmed'
  | 'retry_attempt'
  | 'final_failure'
  | 'create_manual_retry'
  | 'manual_retry_executed'
  | 'partial_write'
  | 'compensation_confirmed';

export interface RelationTransitionInput {
  command: RelationCommand;
  event: RelationEvent;
  now: Date;
  facts: {
    /** 当前状态迁移入参（外部结果） */
    writeResult?: 'success' | 'failure' | 'unknown';
    readback?: {
      confirmedSteps?: RelationWriteStep[];
      /** 回读确认的事实（写回面上） */
      actual?: Partial<Record<string, string>>;
    };
    retryable?: boolean;
    withinRetryWindow?: boolean;
    /** 人工重试前重新鉴权/重读实际关系通过（ORG-027、SRS-SM-ORG-002 人工重试行） */
    manualRetryAuthorized?: boolean;
  };
}

export interface RelationTransitionResult {
  command: RelationCommand;
  readonly requiredSideEffects: string[];
}

export class RelationCommandStateMachine {
  static readonly TABLE: Readonly<Record<RelationEvent, readonly RelationCommandStatus[]>> = {
    submit: ['pending_execution'],
    write_started: ['pending_execution'],
    readback_confirmed: ['processing', 'processing_compensating', 'pending_manual_retry'],
    retry_attempt: ['processing'],
    final_failure: ['processing', 'processing_compensating'],
    create_manual_retry: ['failed_original_preserved'],
    manual_retry_executed: ['pending_manual_retry'],
    partial_write: ['processing'],
    compensation_confirmed: ['processing_compensating', 'pending_manual_retry'],
  };

  private allowedFrom(event: RelationEvent, status: RelationCommandStatus): boolean {
    return RelationCommandStateMachine.TABLE[event].includes(status);
  }

  transition(input: RelationTransitionInput): RelationTransitionResult {
    const { command: original, event, now, facts } = input;
    const stamp = now.toISOString();

    if (!this.allowedFrom(event, original.status)) {
      throw orgError.stateConflict(
        `关系命令当前状态 ${original.status} 不允许执行 ${event}（IFC-ERR-007）`,
      );
    }

    const command: RelationCommand = { ...original };
    let sideEffects: string[] = [];

    switch (event) {
      case 'submit': {
        if (original.status !== 'pending_execution') {
          throw orgError.stateConflict('命令已提交，不得重复提交（IFC-ERR-007）');
        }
        // 提交后仍停留在 pending_execution，真正的写入尝试在 write_started 中计数并
        // 启动 15 分钟重试窗口（ORG-027）。
        command.casdoorRequestId = null;
        sideEffects = ['save_command_audit', 'keep_original_relation', 'enqueue_execution_task'];
        break;
      }

      case 'write_started': {
        command.status = 'processing';
        command.attemptCount += 1;
        command.retryDeadline = stamp;
        sideEffects = ['record_attempt', 'create_readback_task'];
        break;
      }

      case 'readback_confirmed': {
        const allConfirmed =
          facts.readback?.confirmedSteps !== undefined &&
          facts.readback.confirmedSteps.length === command.targetRelation.length &&
          facts.readback.confirmedSteps.every((s) => s.result === 'confirmed');
        // 补偿确认：补偿步骤全部"已补偿"视为补偿收口
        const compensating = original.status === 'processing_compensating';
        const allCompensated =
          facts.readback?.confirmedSteps !== undefined &&
          facts.readback.confirmedSteps.every(
            (s) => s.result === 'confirmed' || s.result === 'compensated',
          );

        if (compensating && allCompensated) {
          command.status = 'failed_original_preserved';
          command.failureReason = '复合关系部分写入失败，补偿已完成，原关系保持有效';
          sideEffects = ['record_compensation_complete', 'notify_operator_admin', 'status_audit'];
          break;
        }
        if (!allConfirmed) {
          throw orgError.externalUnknown('回读未确认全部目标关系，不得转成功（IFC-ERR-013）');
        }
        command.status = 'readback_confirmed';
        command.confirmedAt = stamp;
        command.failureReason = null;
        sideEffects = [
          'record_effective_time',
          'write_immutable_relation_history',
          'issue_or_revoke_permissions',
          'notify_subject_admins',
        ];
        break;
      }

      case 'retry_attempt': {
        if (facts.retryable !== true) {
          throw orgError.precondition('错误不可重试，应提交 final_failure');
        }
        if (facts.withinRetryWindow !== true) {
          throw orgError.precondition('已超出 15 分钟自动重试窗口（ORG-027）');
        }
        command.status = 'processing';
        command.attemptCount += 1;
        sideEffects = ['record_backoff', 'create_readback_task'];
        break;
      }

      case 'final_failure': {
        command.status = 'failed_original_preserved';
        command.failureReason = '15 分钟窗口内无法确认写入结果，原关系保持有效';
        sideEffects = [
          'record_failure',
          'keep_original_relation',
          'notify_operator_admin',
          'status_audit',
        ];
        break;
      }

      case 'create_manual_retry': {
        if (facts.manualRetryAuthorized !== true) {
          throw orgError.forbidden('人工重试前须重新鉴权并重读实际关系（ORG-027）');
        }
        command.status = 'pending_manual_retry';
        command.attemptCount += 1;
        sideEffects = ['save_new_attempt', 'link_original_failure'];
        break;
      }

      case 'manual_retry_executed': {
        command.status = 'pending_execution';
        command.retryDeadline = null;
        sideEffects = ['reauthorize_before_retry', 'readback_actual_relation'];
        break;
      }

      case 'partial_write': {
        // 部分成功：进入补偿中；仅当补偿未确认前不得授予新增权限（ORG-034）
        const compensatingSteps = command.targetRelation.slice().sort((a, b) => b.order - a.order);
        command.status = 'processing_compensating';
        command.failureReason = '复合关系部分写入，进入补偿中';
        sideEffects = [
          'alarm_operator_admin',
          'record_steps_audit',
          `compensate_in_order:${compensatingSteps.map((s) => s.stepId).join(',')}`,
        ];
        break;
      }

      case 'compensation_confirmed': {
        if (original.status !== 'processing_compensating') {
          throw orgError.stateConflict('补偿只允许在补偿中进行（IFC-ERR-007）');
        }
        command.status = 'failed_original_preserved';
        command.failureReason = '复合关系补偿完成，原关系保持有效';
        sideEffects = ['record_compensation_complete', 'notify_operator_admin'];
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
