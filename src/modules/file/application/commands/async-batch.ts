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
