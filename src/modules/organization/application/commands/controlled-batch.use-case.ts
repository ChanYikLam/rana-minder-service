/**
 * ORG-004 受控批量操作用例骨架（SRS-SM-ORG-004）。
 *
 * 属平台模块能力，本模块仅承载状态机驱动与端口接线：平台侧 batch 执行器经
 * ControlledBatchPort 进入，逐阶段调用本用例推进批次状态机。
 */

import { ControlledBatchStateMachine } from '../../domain/state-machines/controlled-batch.state-machine';
import type { ControlledBatchStatus } from '../../domain/types';
import { orgError } from '../../domain/types';
import { CONTROLLED_BATCH_PORT, type ControlledBatchPort } from '../ports';

export interface BatchPhaseInput {
  batchId: string;
  event: string;
  status: ControlledBatchStatus;
  facts: {
    scopeFixed?: boolean;
    previewFresh?: boolean;
    inputsFrozen?: boolean;
    operatorAuthorized?: boolean;
    items?: Array<{ itemId: string; result: 'success' | 'failure'; error?: string }>;
    retryItems?: Array<{ itemId: string; result: 'success' | 'failure'; error?: string }>;
  };
}

/**
 * 批次阶段驱动骨架：校验事件名在状态机内，执行转换并返回新状态与副作用标签。
 * 真实批次的筛选、冻结输入、逐项执行与重试关联在平台模块落地（ORG-040）。
 */
export class ControlledBatchSkeleton {
  private readonly stateMachine = new ControlledBatchStateMachine();

  constructor(private readonly platformPort: ControlledBatchPort) {}

  async drive(input: BatchPhaseInput): Promise<ControlledBatchStatus> {
    const knownEvents = new Set([
      'generate_preview',
      'modify_selection',
      'confirm_execute',
      'item_succeeded',
      'item_failed',
      'all_items_finished',
      'retry_failed_items',
      'retry_items_finished',
    ]);
    if (!knownEvents.has(input.event)) {
      throw orgError.validation(`未知批次事件 ${input.event}`);
    }
    const result = this.stateMachine.transition({
      status: input.status,
      event: input.event as Parameters<ControlledBatchStateMachine['transition']>[0]['event'],
      facts: input.facts,
    });
    await this.platformPort.execute(input.batchId, input.event);
    return result.status;
  }
}

export const controlledBatchProvider = {
  provide: CONTROLLED_BATCH_PORT,
  useFactory: (/** 平台 batch 执行器接入点（本次为桩） */) => ({
    async execute(_batchId: string, _phase: string): Promise<{ ok: boolean }> {
      return { ok: true };
    },
  }),
};
