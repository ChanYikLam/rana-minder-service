/**
 * 部分排序工具（top-k）。
 *
 * 只返回按 key 升序的前 k 个元素，复杂度 O(n log k)（堆）而不是 O(n log n) 全量排序。
 * 稳定性：key 相同时保持原数组顺序（index tiebreak）。
 *
 * 适用场景：下钻明细只展示前 limit 行、但源事实集合可能很大。
 */

function compareEntries(
  a: { key: string | number; index: number },
  b: { key: string | number; index: number },
): number {
  if (a.key < b.key) return -1;
  if (a.key > b.key) return 1;
  return a.index - b.index;
}

interface HeapEntry<T> {
  item: T;
  key: string | number;
  index: number;
}

/**
 * 返回 items 中按 keyOf 升序的前 k 个元素（稳定）。
 * - k <= 0 → 空数组；
 * - items.length <= k → 等价于全量稳定排序。
 *
 * key 必须满足码点可比较（ISO 时间字符串、学号等均满足）。
 */
export function topKSorted<T>(
  items: readonly T[],
  keyOf: (item: T) => string | number,
  k: number,
): T[] {
  const limit = Math.max(0, Math.floor(k));
  if (limit === 0) return [];
  if (items.length <= limit) {
    return [...items]
      .map((item, index) => ({ item, key: keyOf(item), index }))
      .sort(compareEntries)
      .map((e) => e.item);
  }

  // 最大堆：堆顶是当前候选集中 key 最大（且最晚）的元素，最应被新元素淘汰。
  const heap: HeapEntry<T>[] = [];

  function siftUp(i: number): void {
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (compareEntries(heap[i], heap[parent]) <= 0) break;
      [heap[i], heap[parent]] = [heap[parent], heap[i]];
      i = parent;
    }
  }

  function siftDown(i: number): void {
    for (;;) {
      const left = i * 2 + 1;
      const right = left + 1;
      let largest = i;
      if (left < heap.length && compareEntries(heap[left], heap[largest]) > 0) largest = left;
      if (right < heap.length && compareEntries(heap[right], heap[largest]) > 0) largest = right;
      if (largest === i) break;
      [heap[i], heap[largest]] = [heap[largest], heap[i]];
      i = largest;
    }
  }

  for (let i = 0; i < items.length; i++) {
    const entry: HeapEntry<T> = { item: items[i], key: keyOf(items[i]), index: i };
    if (heap.length < limit) {
      heap.push(entry);
      siftUp(heap.length - 1);
    } else if (compareEntries(entry, heap[0]) < 0) {
      // 新元素比堆顶（当前最大候选）更小 → 替换
      heap[0] = entry;
      siftDown(0);
    }
  }

  return heap.sort(compareEntries).map((e) => e.item);
}
