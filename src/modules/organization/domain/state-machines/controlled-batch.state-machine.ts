/**
 * SRS-SM-ORG-004 受控批量操作状态机（8 条转换）。
 *
 * 权威语义：docs/specification/SRS-状态机转换明细-v1.0.md §4.4。
 *
 * 边界：ORG-004 属平台模块（受控批量操作由平台侧的 batch 执行器驱动）；本模块
 * 只承载状态机骨架与端口（ControlledBatchPort），供平台接入时复用转换语义。
 *
 * 关键语义：
 * - 固定一个社团、一个操作类型和一个业务/邀请类型；目标明确（ORG-040）。
 * - 预览后新命中对象不得自动纳入批次；确认后冻结输入，不得重新查询筛选结果。
 * - 单项成功立即保留；单项失败只记录失败，不终止整批或回滚成功项。
 * - 重试仅限原失败项，沿用原业务幂等键；不得包含原成功项。
 */

import type { ControlledBatchStatus } from '../types';
import { orgError } from '../types';

export type BatchEvent =
  | 'generate_preview'
  | 'modify_selection'
  | 'confirm_execute'
  | 'item_succeeded'
  | 'item_failed'
  | 'all_items_finished'
  | 'retry_failed_items'
  | 'retry_items_finished';

export interface BatchItemResult {
  readonly itemId: string;
  readonly result: 'success' | 'failure';
  readonly error?: string;
}

export interface BatchTransitionInput {
  status: ControlledBatchStatus;
  event: BatchEvent;
  facts: {
    /** 生成/确认预览时的作用域校验 */
    scopeFixed?: boolean;
    previewFresh?: boolean;
    inputsFrozen?: boolean;
    operatorAuthorized?: boolean;
    /** 单项终态结果（all_items_finished 时提供） */
    items?: BatchItemResult[];
    /** 本次重试结果 */
    retryItems?: BatchItemResult[];
  };
}

export interface BatchTransitionResult {
  status: ControlledBatchStatus;
  readonly requiredSideEffects: string[];
}

/** 批次终态轴：根据单项结果派生（SRS-SM-ORG-004 汇总行） */
export function deriveBatchTerminal(items: readonly BatchItemResult[]): ControlledBatchStatus {
  const succeeded = items.filter((i) => i.result === 'success').length;
  const failed = items.length - succeeded;
  if (failed === 0) return 'all_succeeded';
  if (succeeded === 0) return 'all_failed';
  return 'partial_success';
}

export class ControlledBatchStateMachine {
  static readonly TABLE: Readonly<Record<BatchEvent, readonly ControlledBatchStatus[]>> = {
    generate_preview: ['selecting'],
    modify_selection: ['previewed_pending_confirm'],
    confirm_execute: ['previewed_pending_confirm'],
    item_succeeded: ['executing'],
    item_failed: ['executing'],
    all_items_finished: ['executing'],
    retry_failed_items: ['partial_success', 'all_failed'],
    retry_items_finished: ['failed_items_retrying'],
  };

  /**
   * 受控批量已知事件集合（唯一来源：状态机转换表）。
   * 供用例层 drive 校验事件合法性，避免与 TABLE 双份维护造成漂移（DRY）。
   */
  static knownEvents(): ReadonlySet<BatchEvent> {
    return new Set<BatchEvent>(Object.keys(ControlledBatchStateMachine.TABLE) as BatchEvent[]);
  }

  private allowedFrom(event: BatchEvent, status: ControlledBatchStatus): boolean {
    return ControlledBatchStateMachine.TABLE[event].includes(status);
  }

  transition(input: BatchTransitionInput): BatchTransitionResult {
    const { status: current, event, facts } = input;

    if (!this.allowedFrom(event, current)) {
      throw orgError.stateConflict(`批次当前状态 ${current} 不允许执行 ${event}（IFC-ERR-007）`);
    }

    let next: ControlledBatchStatus = current;
    let sideEffects: string[] = [];

    switch (event) {
      case 'generate_preview': {
        if (facts.scopeFixed !== true) {
          throw orgError.precondition(
            '必须固定一个社团、一个操作类型和一个业务/邀请类型（ORG-040）',
          );
        }
        next = 'previewed_pending_confirm';
        sideEffects = ['save_preview_audit', 'freeze_filter_snapshot'];
        break;
      }
      case 'modify_selection': {
        if (facts.operatorAuthorized !== true) {
          throw orgError.forbidden('操作者失权，不得修改批次（ORG-040）');
        }
        next = 'selecting';
        sideEffects = ['invalidate_old_preview', 'audit_preview_changed'];
        break;
      }
      case 'confirm_execute': {
        if (facts.previewFresh !== true) {
          throw orgError.precondition('预览已过期，须重新生成（ORG-040）');
        }
        if (facts.inputsFrozen !== true) {
          throw orgError.precondition('批次输入未冻结，不得执行（ORG-040）');
        }
        next = 'executing';
        sideEffects = ['freeze_batch_inputs', 'spawn_item_tasks', 'batch_confirm_audit'];
        break;
      }
      case 'item_succeeded': {
        if (current !== 'executing') {
          throw orgError.stateConflict('单项结果仅执行中可收口（IFC-ERR-007）');
        }
        sideEffects = ['commit_item_success', 'notify_item_subjects'];
        break;
      }
      case 'item_failed': {
        if (current !== 'executing') {
          throw orgError.stateConflict('单项结果仅执行中可收口（IFC-ERR-007）');
        }
        sideEffects = ['record_structured_failure', 'failure_audit'];
        break;
      }
      case 'all_items_finished': {
        if (current !== 'executing') {
          throw orgError.stateConflict('仍在执行中才允许汇总（IFC-ERR-007）');
        }
        next = deriveBatchTerminal(facts.items ?? []);
        sideEffects = ['save_summary', 'completed_time', 'batch_summary_audit'];
        break;
      }
      case 'retry_failed_items': {
        const failed = (facts.items ?? []).filter((i) => i.result === 'failure');
        if (failed.length === 0) {
          throw orgError.precondition('无失败项，无需重试（ORG-040）');
        }
        next = 'failed_items_retrying';
        sideEffects = ['create_retry_batch', 'link_original_batch', 'reauthorize_each_item'];
        break;
      }
      case 'retry_items_finished': {
        next = deriveBatchTerminal(facts.retryItems ?? []);
        sideEffects = ['save_retry_summary', 'monotonic_success_union'];
        break;
      }
      default: {
        const exhaustive: never = event;
        throw orgError.stateConflict(`未支持的事件 ${String(exhaustive)}（IFC-ERR-007）`);
      }
    }

    return { status: next, requiredSideEffects: sideEffects };
  }
}
