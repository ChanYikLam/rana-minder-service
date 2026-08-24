/**
 * topKSorted 单测：部分排序正确性 + 稳定性 + 边界。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { topKSorted } from './sort-utils';

describe('topKSorted', () => {
  it('k >= length：等价全量升序排序', () => {
    const arr = [5, 1, 4, 2, 3];
    assert.deepEqual(
      topKSorted(arr, (n) => n, 10),
      [1, 2, 3, 4, 5],
    );
    assert.deepEqual(
      topKSorted(arr, (n) => n, 5),
      [1, 2, 3, 4, 5],
    );
  });

  it('k < length：只返回前 k 个最小的', () => {
    const arr = [50, 10, 40, 20, 30];
    assert.deepEqual(
      topKSorted(arr, (n) => n, 3),
      [10, 20, 30],
    );
    assert.deepEqual(
      topKSorted(arr, (n) => n, 1),
      [10],
    );
    assert.deepEqual(
      topKSorted(arr, (n) => n, 4),
      [10, 20, 30, 40],
    );
  });

  it('k <= 0：返回空数组', () => {
    assert.deepEqual(
      topKSorted([1, 2, 3], (n) => n, 0),
      [],
    );
    assert.deepEqual(
      topKSorted([1, 2, 3], (n) => n, -5),
      [],
    );
  });

  it('空数组：返回空数组', () => {
    assert.deepEqual(
      topKSorted([], (n) => n, 5),
      [],
    );
  });

  it('稳定性：key 相同时保持原数组顺序', () => {
    const arr = [
      { id: 'a', key: 'S001' },
      { id: 'b', key: 'S001' },
      { id: 'c', key: 'S002' },
      { id: 'd', key: 'S002' },
      { id: 'e', key: 'S000' },
    ];
    const top3 = topKSorted(arr, (x) => x.key, 3);
    assert.deepEqual(
      top3.map((x) => x.id),
      ['e', 'a', 'b'],
      'S000 在前，两个 S001 按原顺序 a、b',
    );
  });

  it('字符串 key（ISO 时间）按码点序即时间序', () => {
    const rows = [
      { id: 't3', at: '2025-09-03' },
      { id: 't1', at: '2025-09-01' },
      { id: 't2', at: '2025-09-02' },
    ];
    assert.deepEqual(
      topKSorted(rows, (r) => r.at, 2).map((r) => r.id),
      ['t1', 't2'],
    );
  });

  it('混合 key 类型按码点比较', () => {
    const arr = [10, '9', 2, '1'];
    assert.deepEqual(
      topKSorted(arr, (n) => n as string | number, 4),
      ['1', 2, '9', 10],
    );
  });

  it('大数据集正确性：与全量排序结果一致', () => {
    const arr = Array.from({ length: 5000 }, (_, i) => (i * 7919) % 10000);
    const k = 200;
    const expected = [...arr].sort((a, b) => a - b).slice(0, k);
    assert.deepEqual(
      topKSorted(arr, (n) => n, k),
      expected,
    );
  });
});
