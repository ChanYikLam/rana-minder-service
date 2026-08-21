import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { computeFrozenSpan } from './freeze-extension';

describe('computeFrozenSpan', () => {
  it('无受阻区间 → 零时长', () => {
    const r = computeFrozenSpan([], new Date('2026-08-01T00:00:00.000Z'));
    assert.equal(r.durationMs, 0);
    assert.equal(r.residualStartAt, null);
  });

  it('进行中区间计算到 now', () => {
    const r = computeFrozenSpan(
      [{ startAt: '2026-07-30T00:00:00.000Z', endAt: null }],
      new Date('2026-08-01T00:00:00.000Z'),
    );
    assert.equal(r.durationMs, 172800000);
    assert.notEqual(r.residualStartAt, null);
  });

  it('已结束区间只计算到 endAt', () => {
    const r = computeFrozenSpan(
      [{ startAt: '2026-07-30T00:00:00.000Z', endAt: '2026-07-31T00:00:00.000Z' }],
      new Date('2026-08-01T00:00:00.000Z'),
    );
    assert.equal(r.durationMs, 86400000);
    assert.equal(r.residualStartAt, null);
  });

  it('重叠区间按并集去重（最早起点 → 最晚终点）', () => {
    const r = computeFrozenSpan(
      [
        { startAt: '2026-07-30T00:00:00.000Z', endAt: '2026-07-31T00:00:00.000Z' },
        { startAt: '2026-07-31T00:00:00.000Z', endAt: '2026-08-01T00:00:00.000Z' },
      ],
      new Date('2026-08-02T00:00:00.000Z'),
    );
    // 并集 07-30 → 08-01 = 172800000，不重复累计
    assert.equal(r.durationMs, 172800000);
  });

  it('区间间空窗不计入（仅累加实际受阻时长，ORG-028）', () => {
    const r = computeFrozenSpan(
      [
        { startAt: '2026-07-30T00:00:00.000Z', endAt: '2026-07-31T00:00:00.000Z' },
        { startAt: '2026-08-02T00:00:00.000Z', endAt: '2026-08-03T00:00:00.000Z' },
      ],
      new Date('2026-08-05T00:00:00.000Z'),
    );
    // 07-30→07-31（1 天）+ 08-02→08-03（1 天）= 2 天；中间 08-01 空窗不计
    assert.equal(r.durationMs, 172800000);
    assert.equal(r.residualStartAt, null);
  });
});
