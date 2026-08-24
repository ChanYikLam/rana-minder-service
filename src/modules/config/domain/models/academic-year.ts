/**
 * 系统自动学年纯领域模型（CFG-003，5.5.3）。
 *
 * 「学年由系统根据平台时区和可配置的年度分界日自动生成、命名并切换当前值，
 * 不要求超管逐年手工创建」；「新建招新活动、任期、换届和统计默认关联当前
 * 学年」。本模块只做学年的命名/区间换算/当前值解析与历史重写比对，不含
 * 数据库、HTTP 与依赖注入。
 *
 * 关键不变量（CFG-003）：
 * - 学年名形如 'YYYY-YYYY+1'；startDate 为分界日当年该时区当地零点，
 *   endDate 为次年分界日前一天 23:59:59.999 当地时刻，相邻学年首尾相接不重叠；
 * - 分界日当天当地零点（含）起归属新学年；
 * - 「已被业务使用的历史学年不得因规则变化被自动重写」：
 *   findRewrittenHistoricalYears 只做纯比对，调用方据此拒绝规则变更；
 * - 时区/夏令时换算仅用 Intl.DateTimeFormat(timeZone)（Node >=24 引擎），
 *   不引入第三方库。
 */

import { ConfigDomainError } from '../errors';

/** 学年分界规则：平台时区内每年该月该日的当地零点为新学年开始 */
export interface AcademicYearBoundary {
  readonly month: number;
  readonly day: number;
  readonly timeZone: string;
}

/** 学年快照：name 形如 'YYYY-YYYY+1'，区间为 [startDate, endDate] 闭合时刻 */
export interface AcademicYearSnapshot {
  readonly name: string;
  readonly startDate: Date;
  readonly endDate: Date;
}

const MS_PER_MINUTE = 60_000;

/** 单次批量生成的学年数量上限（预生成范围进入平台配置清单，防失控） */
export const MAX_GENERATE_COUNT = 50;

/**
 * 用非闰年 2001 的每月天数做分界日上限：02-29 一律拒绝——
 * 分界规则是跨年复用配置，若允许 02-29 则平年没有对应分界日，规则不稳定。
 */
const DAYS_IN_MONTH_NON_LEAP = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/**
 * 计算时刻 instant 在 timeZone 的 UTC 偏移分钟数（东区为正）。
 * 用 formatToParts 取 timeZoneName:'longOffset'（如 'GMT+08:00'/'GMT-04:30'/'GMT'）
 * 解析；'GMT' 视作 0；非法时区抛 CFG_VALIDATION('未知时区')。
 */
export function getTimeZoneOffsetMinutes(instant: Date, timeZone: string): number {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      timeZoneName: 'longOffset',
    }).formatToParts(instant);
  } catch {
    throw new ConfigDomainError('CFG_VALIDATION', '未知时区', { timeZone });
  }
  const offsetText = parts.find((part) => part.type === 'timeZoneName')?.value ?? '';
  // 零偏移按 ECMA-402 longOffset 规范输出 'GMT'；'UTC' 为兼容写法一并接受
  if (offsetText === 'GMT' || offsetText === 'UTC') {
    return 0;
  }
  const match = /^GMT([+-])(\d{1,2}):(\d{2})$/.exec(offsetText);
  if (!match) {
    throw new ConfigDomainError('CFG_VALIDATION', '无法解析时区偏移量', {
      timeZone,
      offsetText,
    });
  }
  const sign = match[1] === '+' ? 1 : -1;
  return sign * (Number(match[2]) * 60 + Number(match[3]));
}

/**
 * 求该时区当地 Y-M-D 零点对应的 UTC 时刻（经典两轮逼近法：
 * 先把墙钟当作 UTC 粗解，再按该处偏移校正并再次校正，
 * 以覆盖校正跨过夏令时切换导致偏移变化的情形）。
 */
export function zonedMidnightUtc(year: number, month: number, day: number, timeZone: string): Date {
  const wallAsUtcMs = Date.UTC(year, month - 1, day);
  let resolvedMs = wallAsUtcMs;
  for (let round = 0; round < 2; round += 1) {
    const offsetMinutes = getTimeZoneOffsetMinutes(new Date(resolvedMs), timeZone);
    const correctedMs = wallAsUtcMs - offsetMinutes * MS_PER_MINUTE;
    if (correctedMs === resolvedMs) {
      break;
    }
    resolvedMs = correctedMs;
  }
  return new Date(resolvedMs);
}

/** 校验分界日合法性：1≤month≤12 且 day 在该月合法（闰年安全），违反抛 CFG_VALIDATION */
export function validateBoundary(month: number, day: number): void {
  if (!Number.isInteger(month) || !Number.isInteger(day)) {
    throw new ConfigDomainError('CFG_VALIDATION', '分界日月/日必须为整数', { month, day });
  }
  if (month < 1 || month > 12) {
    throw new ConfigDomainError('CFG_VALIDATION', '分界月必须在 1..12 范围内', { month, day });
  }
  const maxDay = DAYS_IN_MONTH_NON_LEAP[month - 1];
  if (day < 1 || day > maxDay) {
    throw new ConfigDomainError(
      'CFG_VALIDATION',
      `分界日在该月不存在（按非闰年上限 ${maxDay} 天校验，02-29 一律拒绝）`,
      { month, day },
    );
  }
}

/** 含该时刻的学年名（'YYYY-YYYY+1'）；boundary 先过 validateBoundary */
export function academicYearNameForDate(date: Date, boundary: AcademicYearBoundary): string {
  validateBoundary(boundary.month, boundary.day);
  // 与当地零点分界比较的是绝对时刻，跨时区语义一致
  const calendarYear = date.getUTCFullYear();
  const thisYearStart = zonedMidnightUtc(
    calendarYear,
    boundary.month,
    boundary.day,
    boundary.timeZone,
  );
  // 分界日当天零点（含）起归属新学年
  const startCalendarYear =
    date.getTime() >= thisYearStart.getTime() ? calendarYear : calendarYear - 1;
  return `${startCalendarYear}-${startCalendarYear + 1}`;
}

function buildAcademicYearSnapshot(
  startCalendarYear: number,
  boundary: AcademicYearBoundary,
): AcademicYearSnapshot {
  const startDate = zonedMidnightUtc(
    startCalendarYear,
    boundary.month,
    boundary.day,
    boundary.timeZone,
  );
  const nextStartDate = zonedMidnightUtc(
    startCalendarYear + 1,
    boundary.month,
    boundary.day,
    boundary.timeZone,
  );
  return {
    name: `${startCalendarYear}-${startCalendarYear + 1}`,
    startDate,
    endDate: new Date(nextStartDate.getTime() - 1),
  };
}

export interface GenerateAcademicYearsInput {
  readonly boundary: AcademicYearBoundary;
  /** 首个学年的起始日历年（该年分界日的当地零点即首个 startDate） */
  readonly firstCalendarYear: number;
  /** 生成数量，1..50 越界抛 CFG_VALIDATION */
  readonly count: number;
}

/**
 * 升序生成 count 个连续学年快照；生成后内部跑 assertNoOverlap 完整性自检
 * （相邻学年首尾相接且不重叠是生成器的硬不变量）。
 */
export function generateAcademicYears(input: GenerateAcademicYearsInput): AcademicYearSnapshot[] {
  const { boundary, firstCalendarYear, count } = input;
  validateBoundary(boundary.month, boundary.day);
  if (!Number.isInteger(count) || count < 1 || count > MAX_GENERATE_COUNT) {
    throw new ConfigDomainError(
      'CFG_VALIDATION',
      `学年生成数量必须在 1..${MAX_GENERATE_COUNT} 范围内`,
      { count },
    );
  }
  if (!Number.isInteger(firstCalendarYear)) {
    throw new ConfigDomainError('CFG_VALIDATION', '首学年起始日历年必须为整数', {
      firstCalendarYear,
    });
  }
  const years: AcademicYearSnapshot[] = [];
  for (let i = 0; i < count; i += 1) {
    years.push(buildAcademicYearSnapshot(firstCalendarYear + i, boundary));
  }
  assertNoOverlap(years);
  return years;
}

/**
 * 解析当前学年：内部生成覆盖 now 日历年±1 共 3 个候选，取包含 now 的那个；
 * 找不到视为内部错误抛 CFG_VALIDATION（防御分支，正常边界下不可达）。
 */
export function resolveCurrentAcademicYear(
  now: Date,
  boundary: AcademicYearBoundary,
): AcademicYearSnapshot {
  const candidates = generateAcademicYears({
    boundary,
    firstCalendarYear: now.getUTCFullYear() - 1,
    count: 3,
  });
  const nowMs = now.getTime();
  const found = candidates.find(
    (year) => nowMs >= year.startDate.getTime() && nowMs <= year.endDate.getTime(),
  );
  if (!found) {
    throw new ConfigDomainError('CFG_VALIDATION', '无法确定当前学年（候选区间未覆盖该时刻）', {
      now: now.toISOString(),
      boundary,
    });
  }
  return found;
}

/**
 * CFG-003 历史保护：「已被业务使用的历史学年不得被自动重写」。
 * 按 name 对齐比对 start/end 时刻，不一致的学年名列表；regenerated 缺失的
 * 历史名不算重写（只比对交集同名）。本函数只做纯比对，空数组表示安全，
 * 由调用方据此拒绝规则变更。
 */
export function findRewrittenHistoricalYears(
  existing: readonly AcademicYearSnapshot[],
  regenerated: readonly AcademicYearSnapshot[],
): string[] {
  const regeneratedByName = new Map(regenerated.map((year) => [year.name, year]));
  const rewritten: string[] = [];
  for (const oldYear of existing) {
    const newYear = regeneratedByName.get(oldYear.name);
    if (!newYear) {
      continue;
    }
    if (
      oldYear.startDate.getTime() !== newYear.startDate.getTime() ||
      oldYear.endDate.getTime() !== newYear.endDate.getTime()
    ) {
      rewritten.push(oldYear.name);
    }
  }
  return rewritten;
}

/**
 * 完整性自检（供规则变更后调用）：要求 startDate 升序且每项
 * startDate 严格晚于前一项 endDate（首尾相接且不重叠），破坏抛 CFG_CONFLICT。
 */
export function assertNoOverlap(years: readonly AcademicYearSnapshot[]): void {
  for (let i = 1; i < years.length; i += 1) {
    const prev = years[i - 1];
    const curr = years[i];
    if (curr.startDate.getTime() <= prev.startDate.getTime()) {
      throw new ConfigDomainError('CFG_CONFLICT', '学年未按 startDate 升序排列', {
        prevName: prev.name,
        currName: curr.name,
      });
    }
    if (curr.startDate.getTime() <= prev.endDate.getTime()) {
      throw new ConfigDomainError('CFG_CONFLICT', '学年区间重叠或未首尾相接', {
        prevName: prev.name,
        prevEndDate: prev.endDate.toISOString(),
        currName: curr.name,
        currStartDate: curr.startDate.toISOString(),
      });
    }
  }
}
