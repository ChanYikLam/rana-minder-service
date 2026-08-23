/**
 * 系统自动学年纯领域模型测试（CFG-003，5.5.3）。
 *
 * 覆盖：时区偏移解析（固定偏移/夏令时/零偏移/非法时区）、
 * 时区当地零点换算、分界日校验（02-29 拒绝）、学年归属
 * （分界日当天当地零点起归属新学年）、批量生成与边界时刻精确到毫秒、
 * 当前学年解析、历史学年重写检测（只比对交集同名）与重叠完整性自检。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  academicYearNameForDate,
  assertNoOverlap,
  findRewrittenHistoricalYears,
  generateAcademicYears,
  getTimeZoneOffsetMinutes,
  resolveCurrentAcademicYear,
  validateBoundary,
  zonedMidnightUtc,
} from './academic-year';
import { ConfigDomainError } from '../errors';

/** 断言执行体抛出指定 code 的 ConfigDomainError */
function assertCfgError(run: () => unknown, code: string): void {
  assert.throws(run, (e: Error) => e instanceof ConfigDomainError && e.code === code);
}

const SHANGHAI_BOUNDARY = { month: 8, day: 1, timeZone: 'Asia/Shanghai' };

describe('getTimeZoneOffsetMinutes（CFG-003 时区偏移）', () => {
  it('Asia/Shanghai 无夏令时，任意时刻恒为 +480 分钟', () => {
    assert.equal(getTimeZoneOffsetMinutes(new Date('2026-07-01T00:00:00Z'), 'Asia/Shanghai'), 480);
    assert.equal(getTimeZoneOffsetMinutes(new Date('2026-01-15T00:00:00Z'), 'Asia/Shanghai'), 480);
  });

  it('America/New_York 夏令时 2026-07-01 为 -240 分钟', () => {
    assert.equal(
      getTimeZoneOffsetMinutes(new Date('2026-07-01T00:00:00Z'), 'America/New_York'),
      -240,
    );
  });

  it('America/New_York 冬令时 2026-01-15 为 -300 分钟', () => {
    assert.equal(
      getTimeZoneOffsetMinutes(new Date('2026-01-15T00:00:00Z'), 'America/New_York'),
      -300,
    );
  });

  it("零偏移时区（'UTC'，longOffset 输出 'GMT'）解析为 0", () => {
    assert.equal(getTimeZoneOffsetMinutes(new Date('2026-07-01T00:00:00Z'), 'UTC'), 0);
  });

  it("非法时区 'Not/AZone' 抛 CFG_VALIDATION", () => {
    assertCfgError(() => getTimeZoneOffsetMinutes(new Date(), 'Not/AZone'), 'CFG_VALIDATION');
  });
});

describe('zonedMidnightUtc（CFG-003 当地零点换算）', () => {
  it('Asia/Shanghai 2026-08-01 当地零点 === 2026-07-31T16:00:00.000Z', () => {
    const result = zonedMidnightUtc(2026, 8, 1, 'Asia/Shanghai');
    assert.equal(result.toISOString(), '2026-07-31T16:00:00.000Z');
  });

  it('America/New_York 2026-08-01 当地零点 === 2026-08-01T04:00:00.000Z（夏令时）', () => {
    const result = zonedMidnightUtc(2026, 8, 1, 'America/New_York');
    assert.equal(result.toISOString(), '2026-08-01T04:00:00.000Z');
  });

  it('America/New_York 2026-01-15 当地零点 === 2026-01-15T05:00:00.000Z（冬令时）', () => {
    const result = zonedMidnightUtc(2026, 1, 15, 'America/New_York');
    assert.equal(result.toISOString(), '2026-01-15T05:00:00.000Z');
  });
});

describe('validateBoundary（CFG-003 分界日校验）', () => {
  it('(8, 1) 通过', () => {
    assert.doesNotThrow(() => validateBoundary(8, 1));
  });

  it('(2, 29) 拒绝：按非闰年上限校验保证规则逐年稳定', () => {
    assertCfgError(() => validateBoundary(2, 29), 'CFG_VALIDATION');
  });

  it('(13, 1) 拒绝', () => {
    assertCfgError(() => validateBoundary(13, 1), 'CFG_VALIDATION');
  });

  it('(0, 10) 拒绝', () => {
    assertCfgError(() => validateBoundary(0, 10), 'CFG_VALIDATION');
  });

  it('(8, 32) 拒绝', () => {
    assertCfgError(() => validateBoundary(8, 32), 'CFG_VALIDATION');
  });
});

describe('academicYearNameForDate（CFG-003 学年归属，分界 08-01 上海）', () => {
  it('2026-09-01 归属 2026-2027', () => {
    assert.equal(
      academicYearNameForDate(new Date('2026-09-01T12:00:00+08:00'), SHANGHAI_BOUNDARY),
      '2026-2027',
    );
  });

  it('2026-07-31T23:59（当地）归属上一学年 2025-2026', () => {
    assert.equal(
      academicYearNameForDate(new Date('2026-07-31T23:59:00+08:00'), SHANGHAI_BOUNDARY),
      '2025-2026',
    );
  });

  it('2026-08-01 当地零点整（含分界日当天）归属新学年 2026-2027', () => {
    assert.equal(
      academicYearNameForDate(new Date('2026-08-01T00:00:00+08:00'), SHANGHAI_BOUNDARY),
      '2026-2027',
    );
  });

  it('boundary 非法时先抛 CFG_VALIDATION', () => {
    assertCfgError(
      () =>
        academicYearNameForDate(new Date(), {
          month: 2,
          day: 29,
          timeZone: 'Asia/Shanghai',
        }),
      'CFG_VALIDATION',
    );
  });
});

describe('generateAcademicYears（CFG-003 批量生成）', () => {
  it('count=3 从 2025 得 2025-2026/2026-2027/2027-2028 且升序', () => {
    const years = generateAcademicYears({
      boundary: SHANGHAI_BOUNDARY,
      firstCalendarYear: 2025,
      count: 3,
    });
    assert.deepEqual(
      years.map((year) => year.name),
      ['2025-2026', '2026-2027', '2027-2028'],
    );
    for (let i = 1; i < years.length; i += 1) {
      assert.ok(years[i].startDate.getTime() > years[i - 1].startDate.getTime());
    }
  });

  it('首年 startDate=2025-07-31T16:00:00.000Z、endDate=2026-07-31T15:59:59.999Z（毫秒级精确）', () => {
    const [first] = generateAcademicYears({
      boundary: SHANGHAI_BOUNDARY,
      firstCalendarYear: 2025,
      count: 1,
    });
    assert.equal(first.startDate.toISOString(), '2025-07-31T16:00:00.000Z');
    assert.equal(first.endDate.toISOString(), '2026-07-31T15:59:59.999Z');
    assert.equal(first.endDate.getTime() - first.startDate.getTime(), 365 * 24 * 3600 * 1000 - 1);
  });

  it('相邻学年首尾相接：次年 startDate === 前年 endDate + 1ms', () => {
    const years = generateAcademicYears({
      boundary: SHANGHAI_BOUNDARY,
      firstCalendarYear: 2025,
      count: 3,
    });
    for (let i = 1; i < years.length; i += 1) {
      assert.equal(years[i].startDate.getTime() - years[i - 1].endDate.getTime(), 1);
    }
  });

  it('count=0 抛 CFG_VALIDATION', () => {
    assertCfgError(
      () =>
        generateAcademicYears({ boundary: SHANGHAI_BOUNDARY, firstCalendarYear: 2025, count: 0 }),
      'CFG_VALIDATION',
    );
  });

  it('count=51 超过上限抛 CFG_VALIDATION', () => {
    assertCfgError(
      () =>
        generateAcademicYears({ boundary: SHANGHAI_BOUNDARY, firstCalendarYear: 2025, count: 51 }),
      'CFG_VALIDATION',
    );
  });
});

describe('resolveCurrentAcademicYear（CFG-003 当前学年切换）', () => {
  it('2026-01-01T00:00:00Z + 上海分界 08-01 → 2025-2026', () => {
    const current = resolveCurrentAcademicYear(new Date('2026-01-01T00:00:00Z'), SHANGHAI_BOUNDARY);
    assert.equal(current.name, '2025-2026');
  });

  it('分界日当天当地零点起已切到新学年：2026-08-01 当地零点 → 2026-2027', () => {
    const current = resolveCurrentAcademicYear(
      new Date('2026-08-01T00:00:00+08:00'),
      SHANGHAI_BOUNDARY,
    );
    assert.equal(current.name, '2026-2027');
    const nowMs = new Date('2026-08-01T00:00:00+08:00').getTime();
    assert.ok(nowMs >= current.startDate.getTime() && nowMs <= current.endDate.getTime());
  });
});

describe('findRewrittenHistoricalYears（CFG-003 历史保护）', () => {
  const existing = generateAcademicYears({
    boundary: SHANGHAI_BOUNDARY,
    firstCalendarYear: 2025,
    count: 2,
  });

  it('同名但起止时刻不一致的历史学年被报出', () => {
    const regenerated = existing.map((year, index) =>
      index === 0 ? { ...year, startDate: new Date(year.startDate.getTime() + 60_000) } : year,
    );
    assert.deepEqual(findRewrittenHistoricalYears(existing, regenerated), ['2025-2026']);
  });

  it('end 变化同样报出；完全一致返回 []', () => {
    const endShifted = existing.map((year, index) =>
      index === 1 ? { ...year, endDate: new Date(year.endDate.getTime() - 1) } : year,
    );
    assert.deepEqual(findRewrittenHistoricalYears(existing, endShifted), ['2026-2027']);
    assert.deepEqual(findRewrittenHistoricalYears(existing, [...existing]), []);
  });

  it('regenerated 缺失的历史名不算重写（只比对交集同名）', () => {
    const partial = [existing[1]];
    assert.deepEqual(findRewrittenHistoricalYears(existing, partial), []);
  });
});

describe('assertNoOverlap（CFG-003 完整性自检）', () => {
  it('generateAcademicYears 连续产出通过', () => {
    const years = generateAcademicYears({
      boundary: SHANGHAI_BOUNDARY,
      firstCalendarYear: 2024,
      count: 5,
    });
    assert.doesNotThrow(() => assertNoOverlap(years));
  });

  it('手工构造重叠（两条都含 2026-06）抛 CFG_CONFLICT', () => {
    const overlapping = [
      {
        name: '2025-2026',
        startDate: new Date('2025-08-01T00:00:00Z'),
        endDate: new Date('2026-07-15T00:00:00Z'),
      },
      {
        name: '2026-2027',
        startDate: new Date('2026-06-01T00:00:00Z'),
        endDate: new Date('2027-07-15T00:00:00Z'),
      },
    ];
    assertCfgError(() => assertNoOverlap(overlapping), 'CFG_CONFLICT');
  });

  it('startDate 未升序排列同样抛 CFG_CONFLICT', () => {
    const unordered = [
      {
        name: '2026-2027',
        startDate: new Date('2026-08-01T00:00:00Z'),
        endDate: new Date('2027-07-31T23:59:59.999Z'),
      },
      {
        name: '2025-2026',
        startDate: new Date('2025-08-01T00:00:00Z'),
        endDate: new Date('2026-07-31T23:59:59.999Z'),
      },
    ];
    assertCfgError(() => assertNoOverlap(unordered), 'CFG_CONFLICT');
  });
});
