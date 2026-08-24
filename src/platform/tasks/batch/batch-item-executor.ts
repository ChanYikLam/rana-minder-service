import { Injectable, Logger } from '@nestjs/common';
import type { BatchItemInput, BatchItemResult, TaskScope } from '../contracts';

export const BATCH_ITEM_EXECUTOR_PORT = Symbol('BATCH_ITEM_EXECUTOR_PORT');

export interface BatchItemExecutorPort {
  execute(
    principalId: string,
    operationType: string,
    businessType: string,
    scope: TaskScope,
    item: BatchItemInput,
  ): Promise<BatchItemResult>;
}

@Injectable()
export class DevelopmentBatchItemExecutor implements BatchItemExecutorPort {
  private readonly logger = new Logger(DevelopmentBatchItemExecutor.name);

  async execute(
    _principalId: string,
    operationType: string,
    _businessType: string,
    _scope: TaskScope,
    item: BatchItemInput,
  ): Promise<BatchItemResult> {
    this.logger.debug(
      `DevelopmentBatchItemExecutor: itemId=${item.itemId}, operationType=${operationType}`,
    );
    return {
      itemId: item.itemId,
      status: 'SUCCEEDED',
      resultRef: `development-batch-item:${item.itemId}`,
    };
  }
}

/**
 * 生产默认批量项执行器：fail-closed（拒绝）。
 * 真实执行接入前禁止任何批量项落库执行；Development 桩仅用于非生产环境。
 */
@Injectable()
export class DenyAllBatchItemExecutor implements BatchItemExecutorPort {
  async execute(
    principalId: string,
    operationType: string,
    businessType: string,
    _scope: TaskScope,
    item: BatchItemInput,
  ): Promise<BatchItemResult> {
    return {
      itemId: item.itemId,
      status: 'REJECTED',
      reason: `production-batch-executor-not-configured:${principalId}:${operationType}:${businessType}`,
    };
  }
}
