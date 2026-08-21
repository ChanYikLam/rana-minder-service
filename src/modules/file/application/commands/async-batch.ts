import type { ObjectLocation } from '../../domain/models/file-model';

/** 对象删除结果的结构化形状（避免工具层强依赖基础设施端口，仅取所需字段） */
export interface DeleteOutcome {
  readonly ok: boolean;
}

/** 可核验删除项（清理队列/删除清单共用的最小结构形状） */
export interface VerifiableDeleteItem {
  readonly location: ObjectLocation;
  readonly status: 'PENDING' | 'VERIFIED_DELETED' | 'FAILED';
}

/**
 * 有界并发工具（对象删除/回读核验等 I/O 批处理用）。
 *
 * 清理任务/删除清单对每个对象执行独立的网络 I/O（S3 DeleteObject+回读），
 * 若用 `Promise.all` 全量并发，单文件含大量版本/派生物时会对对象存储产生
 * 无界突发请求，可能触发限流或内存峰值。此工具按固定窗口并发执行，既保留
 * 并行度又避免突发，且**严格保持输入顺序**输出结果。
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  // 防御：并发窗口必须 ≥ 1，否则 `Math.min(concurrency, items.length)` 会静默跳过全部
  // 待处理项（并发 0）或让 `Array.from({ length: 负数 })` 抛出令人困惑的 RangeError。
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new RangeError(`mapWithConcurrency: 并发数必须为 ≥1 的整数，收到 ${concurrency}`);
  }
  const results = new Array<R>(items.length);
  let next = 0;

  async function worker(): Promise<void> {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await mapper(items[index], index);
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

/**
 * 有界并发逐项删除并回读核验（孤儿清理 / 删除清单共用，消除重复实现）。
 *
 * - 保持输入顺序；已 `VERIFIED_DELETED` 的项直接跳过（幂等重试）；
 * - 删除失败或抛异常 → 置 `FAILED`（不伪装成功，由调用方决定是否保持未完成）；
 * - 全部删除成功 → 置 `VERIFIED_DELETED`。
 */
export async function deleteAndVerifyBatch<T extends VerifiableDeleteItem>(
  items: readonly T[],
  concurrency: number,
  deleteFn: (location: ObjectLocation) => Promise<DeleteOutcome>,
): Promise<T[]> {
  return mapWithConcurrency(items, concurrency, async (item) => {
    if (item.status === 'VERIFIED_DELETED') {
      return item;
    }
    let ok = false;
    try {
      ok = (await deleteFn(item.location)).ok;
    } catch {
      ok = false;
    }
    return { ...item, status: (ok ? 'VERIFIED_DELETED' : 'FAILED') as T['status'] };
  });
}
