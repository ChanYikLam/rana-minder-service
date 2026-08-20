import { Inject, Injectable, Logger } from '@nestjs/common';
import { BatchItemStatus, BatchStatus } from '../contracts';
import type {
  BatchItemInput,
  BatchItemResult,
  BatchPreview,
  BatchRecord,
  TaskRecord,
  TaskScope,
} from '../contracts';
import {
  BATCH_ITEM_AUTHORIZATION_PORT,
  type BatchItemAuthorizationPort,
} from './batch-authorization';
import { BATCH_ITEM_EXECUTOR_PORT, type BatchItemExecutorPort } from './batch-item-executor';
import { BATCH_STORE, type BatchStore } from './batch-store';
import { selectRetryableItems, summarizeBatch, validateRetryBatch } from './batch-rules';

@Injectable()
export class BatchOrchestrator {
  private readonly logger = new Logger(BatchOrchestrator.name);

  constructor(
    @Inject(BATCH_STORE) private readonly store: BatchStore,
    @Inject(BATCH_ITEM_AUTHORIZATION_PORT)
    private readonly authorization: BatchItemAuthorizationPort,
    @Inject(BATCH_ITEM_EXECUTOR_PORT)
    private readonly executor: BatchItemExecutorPort,
  ) {}

  async preview(
    batchId: string,
    scope: TaskScope,
    operationType: string,
    businessType: string,
    items: readonly BatchItemInput[],
    operatorId: string,
    now: Date,
  ): Promise<BatchPreview> {
    this.assertPreviewInputs(scope, operationType, businessType, items);

    const existing = await this.store.findById(batchId);
    const previewVersion = (existing?.previewVersion ?? 0) + 1;
    const batch: BatchRecord = {
      batchId,
      previewVersion,
      scope,
      operationType,
      businessType,
      status: BatchStatus.PREVIEWED,
      frozenItems: [...items],
      itemResults: [],
      createdAt: now.toISOString(),
    };
    await this.store.save(batch);

    return {
      batchId,
      previewVersion,
      scope,
      operationType,
      businessType,
      items: [...items],
      createdAt: now.toISOString(),
      createdBy: operatorId,
    };
  }

  async confirmAndFreeze(
    batchId: string,
    previewVersion: number,
    operatorId: string,
    now: Date,
  ): Promise<BatchRecord> {
    const batch = await this.requireBatch(batchId);
    if (batch.status !== BatchStatus.PREVIEWED) {
      throw new Error(`批次当前状态不可确认：${batch.status}`);
    }
    if (batch.previewVersion !== previewVersion) {
      throw new Error('批次预览版本不匹配，请重新预览');
    }
    const frozen: BatchRecord = {
      ...batch,
      status: BatchStatus.EXECUTING,
      confirmedAt: now.toISOString(),
      itemResults: [],
    };
    await this.store.save(frozen);
    this.logger.log(`批次已冻结并开始执行：batchId=${batchId}, operatorId=${operatorId}`);
    return frozen;
  }

  async executeFrozenBatch(task: TaskRecord, now: Date): Promise<BatchRecord> {
    const payload = task.payload as { batchId: string; operatorId: string };
    const batch = await this.requireBatch(payload.batchId);
    if (batch.status !== BatchStatus.EXECUTING && batch.status !== BatchStatus.RETRYING_FAILED) {
      throw new Error(`批次状态不可执行：${batch.status}`);
    }

    const results = [...batch.itemResults];
    for (const item of batch.frozenItems) {
      const existing = results.find((r) => r.itemId === item.itemId);
      if (existing !== undefined && existing.status === BatchItemStatus.SUCCEEDED) {
        continue;
      }

      const auth = await this.authorization.verify(
        payload.operatorId,
        batch.operationType,
        batch.businessType,
        item,
      );
      if (auth.ok === false) {
        this.upsertResult(results, {
          itemId: item.itemId,
          status: BatchItemStatus.REJECTED,
          reason: auth.reason ?? '批量逐项鉴权拒绝',
        });
        continue;
      }

      try {
        const result = await this.executor.execute(
          payload.operatorId,
          batch.operationType,
          batch.businessType,
          batch.scope,
          item,
        );
        this.upsertResult(results, result);
      } catch (err) {
        this.upsertResult(results, {
          itemId: item.itemId,
          status: BatchItemStatus.FAILED,
          reason: err instanceof Error ? err.message : String(err),
        });
      }
    }

    const summary = summarizeBatch({ ...batch, itemResults: results });
    const done = summary.status !== BatchStatus.EXECUTING;
    const completed: BatchRecord = {
      ...batch,
      status: summary.status,
      itemResults: results,
      completedAt: done ? now.toISOString() : undefined,
    };
    await this.store.save(completed);
    return completed;
  }

  async retryFailedItems(
    originalBatchId: string,
    operatorId: string,
    now: Date,
    requestedItems?: readonly BatchItemInput[],
  ): Promise<BatchRecord> {
    const original = await this.requireBatch(originalBatchId);
    const items =
      requestedItems ?? selectRetryableItems(original.frozenItems, original.itemResults);
    const validation = validateRetryBatch(
      original,
      items,
      original.operationType,
      original.businessType,
      original.scope.kind,
    );
    if (validation.ok === false) {
      throw new Error(validation.reason ?? '非法重试批次');
    }

    const retryBatchId = `${originalBatchId}:retry:${now.getTime()}`;
    const retryBatch: BatchRecord = {
      batchId: retryBatchId,
      parentBatchId: original.batchId,
      previewVersion: 1,
      scope: original.scope,
      operationType: original.operationType,
      businessType: original.businessType,
      status: BatchStatus.RETRYING_FAILED,
      frozenItems: [...items],
      itemResults: [],
      createdAt: now.toISOString(),
      confirmedAt: now.toISOString(),
    };
    await this.store.save(retryBatch);
    this.logger.log(`失败项重试批次已创建：batchId=${retryBatchId}, operatorId=${operatorId}`);
    return retryBatch;
  }

  private async requireBatch(batchId: string): Promise<BatchRecord> {
    const batch = await this.store.findById(batchId);
    if (batch === null) throw new Error(`批次不存在：${batchId}`);
    return batch;
  }

  private assertPreviewInputs(
    scope: TaskScope,
    operationType: string,
    businessType: string,
    items: readonly BatchItemInput[],
  ): void {
    if (scope.kind !== 'CLUB') {
      throw new Error('批量前提：必须固定一个社团（跨社团批量一律拒绝）');
    }
    if (scope.clubId === undefined) {
      throw new Error('批量社团作用域缺少 clubId');
    }
    if (operationType.length === 0 || businessType.length === 0) {
      throw new Error('批量操作类型与业务/邀请类型不得为空');
    }
    if (items.length === 0) {
      throw new Error('批量目标集合为空');
    }
    const ids = new Set<string>();
    for (const item of items) {
      if (ids.has(item.itemId)) {
        throw new Error(`批量目标重复：${item.itemId}`);
      }
      ids.add(item.itemId);
    }
  }

  private upsertResult(results: BatchItemResult[], result: BatchItemResult): void {
    const index = results.findIndex((r) => r.itemId === result.itemId);
    if (index >= 0) results[index] = result;
    else results.push(result);
  }
}
