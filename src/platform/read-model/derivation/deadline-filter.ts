/**
 * 截止时间筛选（C6.7）。
 *
 * 报名截止提供"今日截止 / 3 日内 / 7 日内 / 自定义起止"，由服务端按
 * **平台时区自然日**转换（半开区间：截止晚于服务端时刻且落入窗口）。
 * "正在报名"由查询时公开资格＋通道开放＋无暂停/终态覆盖＋截止晚于
 * 服务端时刻共同派生，不是持久状态（见 visibility-derivation）。
 *
 * 首版预设：TODAY / 3DAYS / 7DAYS；自定义起止（CUSTOM）待 RANGE
 * 操作符扩展后登记。
 */
export const DeadlinePreset = {
  TODAY: 'TODAY',
  DAYS_3: '3DAYS',
  DAYS_7: '7DAYS',
} as const;

export type DeadlinePreset = (typeof DeadlinePreset)[keyof typeof DeadlinePreset];

/** 平台时区偏移（分钟）。首版固定东八区；服务端按平台时区自然日转换 */
export const PLATFORM_TZ_OFFSET_MINUTES = 8 * 60;

const PRESET_DAYS: Record<DeadlinePreset, number> = {
  [DeadlinePreset.TODAY]: 1,
  [DeadlinePreset.DAYS_3]: 3,
  [DeadlinePreset.DAYS_7]: 7,
};

/**
 * 截止窗口判定（纯函数）。
 *
 * 窗口起点 = 服务端时刻所在**平台时区自然日 00:00**；
 * 窗口终点 = 起点 + preset 天数（半开：截止 ≤ 起点视为已过）。
 * 截止必须严格晚于服务端时刻（半开区间语义）且不晚于窗口终点。
 */
export class DeadlineFilterRule {
  /** deadlineAt 是否落在 preset 自然日窗口内（且未过） */
  isWithin(deadlineAt: string, preset: DeadlinePreset, now: string): boolean {
    const deadline = Date.parse(deadlineAt);
    const n = Date.parse(now);
    if (!Number.isFinite(deadline) || !Number.isFinite(n)) {
      return false;
    }
    if (deadline <= n) {
      return false; // 截止已过（半开：等于视为已过）
    }
    const dayStart = this.naturalDayStart(n);
    const windowEnd = dayStart + PRESET_DAYS[preset] * 86_400_000;
    // 半开区间 [dayStart, windowEnd)：截止恰为窗口终点（下一自然日 00:00）视为窗口外
    return deadline < windowEnd;
  }

  /** 平台时区自然日 00:00 的毫秒时间戳 */
  private naturalDayStart(ms: number): number {
    const shifted = ms + PLATFORM_TZ_OFFSET_MINUTES * 60_000;
    const dayStartShifted = Math.floor(shifted / 86_400_000) * 86_400_000;
    return dayStartShifted - PLATFORM_TZ_OFFSET_MINUTES * 60_000;
  }

  /**
   * 自定义起止（C6.7/RANGE）：deadlineAt ∈ [from, to)（半开）。
   *
   * 纯日期输入（YYYY-MM-DD）按平台时区自然日转换：from=当日 00:00、to=次日 00:00；
   * 带时间输入按原值参与区间。截止必须严格晚于服务端时刻。
   */
  isWithinRange(
    deadlineAt: string,
    range: { from?: string; to?: string },
    now: string,
  ): boolean {
    const deadline = Date.parse(deadlineAt);
    const n = Date.parse(now);
    if (!Number.isFinite(deadline) || !Number.isFinite(n)) {
      return false;
    }
    if (deadline <= n) {
      return false; // 已过
    }
    if (range.from !== undefined) {
      const from = this.normalizeBound(range.from, 'start');
      if (deadline < from) {
        return false;
      }
    }
    if (range.to !== undefined) {
      const to = this.normalizeBound(range.to, 'end');
      if (deadline >= to) {
        return false; // 半开
      }
    }
    return true;
  }

  private normalizeBound(v: string, end: 'start' | 'end'): number {
    const ms = Date.parse(v);
    if (!Number.isFinite(ms)) {
      return Number.NaN;
    }
    // 纯日期 → 平台时区自然日边界（from=00:00 / to=次日 00:00）
    if (/^\d{4}-\d{2}-\d{2}$/.test(v)) {
      const dayStart = this.naturalDayStart(ms);
      return end === 'start' ? dayStart : dayStart + 86_400_000;
    }
    return ms;
  }
}
