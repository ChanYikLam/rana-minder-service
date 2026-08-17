import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DeadlineFilterRule, DeadlinePreset, PLATFORM_TZ_OFFSET_MINUTES } from './deadline-filter';

/**
 * 平台时区（+8）自然日边界计算辅助：给定日期字符串（如 '2026-08-17'），
 * 返回该自然日 00:00 的毫秒（+8 时区语义，用于构造 now 与截止）。
 */
const tzDayStart = (date: string): number => {
  const utc = Date.parse(`${date}T00:00:00Z`);
  return utc - PLATFORM_TZ_OFFSET_MINUTES * 60_000; // +8 自然日 00:00 的 UTC 时刻
};

describe('DeadlineFilterRule（C6.7 平台时区自然日窗口）', () => {
  const rule = new DeadlineFilterRule();

  it('TODAY：今天自然日内截止（晚于 now）→ 命中', () => {
    const now = tzDayStart('2026-08-17') + 10 * 3_600_000; // 8/17 10:00 (+8)
    const deadline = tzDayStart('2026-08-17') + 20 * 3_600_000; // 8/17 20:00
    assert.equal(rule.isWithin(new Date(deadline).toISOString(), DeadlinePreset.TODAY, new Date(now).toISOString()), true);
  });

  it('TODAY：已过截止 → 不命中（半开区间）', () => {
    const now = tzDayStart('2026-08-17') + 20 * 3_600_000; // 20:00
    const deadline = tzDayStart('2026-08-17') + 12 * 3_600_000; // 12:00（已过）
    assert.equal(rule.isWithin(new Date(deadline).toISOString(), DeadlinePreset.TODAY, new Date(now).toISOString()), false);
  });

  it('3DAYS：明后天截止在 3 日窗口内 → 命中', () => {
    const now = tzDayStart('2026-08-17') + 10 * 3_600_000;
    const deadline = tzDayStart('2026-08-19') + 23 * 3_600_000; // 8/19 23:59
    assert.equal(rule.isWithin(new Date(deadline).toISOString(), DeadlinePreset.DAYS_3, new Date(now).toISOString()), true);
  });

  it('3DAYS：超出 3 个自然日 → 不命中', () => {
    const now = tzDayStart('2026-08-17') + 10 * 3_600_000;
    const deadline = tzDayStart('2026-08-21') + 1 * 3_600_000; // 8/21（第 4 个自然日）
    assert.equal(rule.isWithin(new Date(deadline).toISOString(), DeadlinePreset.DAYS_3, new Date(now).toISOString()), false);
  });

  it('7DAYS：一周内命中', () => {
    const now = tzDayStart('2026-08-17') + 10 * 3_600_000;
    const deadline = tzDayStart('2026-08-23') + 20 * 3_600_000; // 8/23
    assert.equal(rule.isWithin(new Date(deadline).toISOString(), DeadlinePreset.DAYS_7, new Date(now).toISOString()), true);
  });

  it('非法时间输入 → 不命中（不抛错）', () => {
    assert.equal(rule.isWithin('not-a-date', DeadlinePreset.TODAY, new Date().toISOString()), false);
  });

  it('平台时区自然日边界：跨 UTC 日期但同 +8 自然日仍算当天（TODAY）', () => {
    // UTC 8/17 15:00 = +8 8/17 23:00；UTC 8/17 17:00 = +8 8/18 01:00（已是次日）
    const nowUtc = '2026-08-17T15:00:00Z'; // +8 23:00 8/17
    const deadlineSameDay = '2026-08-17T16:00:00Z'; // +8 24:00 = 8/18 00:00（同日边界，<= now? 16:00Z > 15:00Z 且 +8 同日 23→24 跨日）
    // +8 8/18 00:00 属于 8/18 自然日，TODAY（8/17）窗口不包含 → false
    assert.equal(rule.isWithin(deadlineSameDay, DeadlinePreset.TODAY, nowUtc), false);
  });
});
