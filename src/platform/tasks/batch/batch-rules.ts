import { BatchItemStatus, BatchStatus } from '../contracts';
import type { BatchItemInput, BatchItemResult, BatchRecord, BatchSummary } from '../contracts';

export function summarizeBatch(
  batch: Pick<BatchRecord, 'batchId' | 'frozenItems' | 'itemResults'>,
): BatchSummary {
  const resultMap = new Map(batch.itemResults.map((r) => [r.itemId, r]));
  let succeeded = 0;
  let failed = 0;
  let rejected = 0;
  for (const item of batch.frozenItems) {
    const result = resultMap.get(item.itemId);
    if (result === undefined) continue;
    if (result.status === BatchItemStatus.SUCCEEDED) succeeded += 1;
    if (result.status === BatchItemStatus.FAILED) failed += 1;
    if (result.status === BatchItemStatus.REJECTED) rejected += 1;
  }

  return {
    batchId: batch.batchId,
    status: deriveBatchStatus(
      batch.frozenItems.length,
      batch.itemResults.length,
      succeeded,
      failed,
      rejected,
    ),
    succeeded,
    failed,
    rejected,
    total: batch.frozenItems.length,
  };
}

export function deriveBatchStatus(
  total: number,
  completed: number,
  succeeded: number,
  _failed: number,
  _rejected: number,
): BatchStatus {
  if (total === 0) return BatchStatus.ALL_SUCCEEDED;
  if (completed < total) return BatchStatus.EXECUTING;
  if (succeeded === total) return BatchStatus.ALL_SUCCEEDED;
  if (succeeded === 0) return BatchStatus.ALL_FAILED;
  return BatchStatus.PARTIALLY_SUCCEEDED;
}

export function selectRetryableItems(
  frozenItems: readonly BatchItemInput[],
  itemResults: readonly BatchItemResult[],
): readonly BatchItemInput[] {
  const failedIds = new Set(
    itemResults.filter((r) => r.status === BatchItemStatus.FAILED).map((r) => r.itemId),
  );
  return frozenItems.filter((item) => failedIds.has(item.itemId));
}

export function validateRetryBatch(
  original: Pick<
    BatchRecord,
    'frozenItems' | 'itemResults' | 'operationType' | 'businessType' | 'scope'
  >,
  retryItems: readonly BatchItemInput[],
  operationType: string,
  businessType: string,
  scopeKind: string,
): { ok: boolean; reason?: string } {
  if (operationType !== original.operationType) {
    return { ok: false, reason: '重试批次操作类型与原批次不一致' };
  }
  if (businessType !== original.businessType) {
    return { ok: false, reason: '重试批次业务/邀请类型与原批次不一致' };
  }
  if (scopeKind !== original.scope.kind) {
    return { ok: false, reason: '重试批次作用域类型与原批次不一致' };
  }

  const originalIds = new Set(original.frozenItems.map((i) => i.itemId));
  const allowedIds = new Set(
    selectRetryableItems(original.frozenItems, original.itemResults).map((i) => i.itemId),
  );
  const seen = new Set<string>();
  for (const item of retryItems) {
    if (originalIds.has(item.itemId) === false) {
      return { ok: false, reason: `重试批次包含原批次外的新对象：${item.itemId}` };
    }
    if (allowedIds.has(item.itemId) === false) {
      return { ok: false, reason: `重试批次包含原成功项或非失败项：${item.itemId}` };
    }
    if (seen.has(item.itemId)) {
      return { ok: false, reason: `重试批次重复包含同一失败项：${item.itemId}` };
    }
    seen.add(item.itemId);
  }
  return { ok: true };
}

export function isRetryableItemResult(result: BatchItemResult): boolean {
  return result.status === BatchItemStatus.FAILED;
}
