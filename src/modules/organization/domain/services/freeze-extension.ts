/**
 * 冻结期限顺延服务（ORG-028、ORG-010）。
 *
 * 语义：
 * - 普通停用 / 紧急强制停用 / 同步异常进入时都记录受阻起点（freezeStart）；
 *   重叠区间按并集去重（SRS-SM-ORG-001 重新启用行）。
 * - 重新启用时，按从"最早未结算受阻起点"到"重新启用提交时刻"的实际时长一次性
 *   顺延被冻结期限；每个受阻区间只结算一次，重复启用不重复延长（ORG-028）。
 *
 * 本服务是纯计算：不落库；用例层将结算结果写回社团聚合与将顺延应用到受影响
 * 业务期限。
 */

export interface FreezeInterval {
  readonly startAt: string;
  readonly endAt: string | null;
}

export interface FreezeSettlement {
  /** 本次实际受阻时长（毫秒；从最早未结算起点到 now） */
  readonly durationMs: number;
  /** 结算后的未结算起点（一般应为 null；若随后又进入新的受阻，由后续事件重设） */
  readonly residualStartAt: string | null;
  /** 已结算区间的原始起点（用于审计） */
  readonly settledFromAt: string;
}

const toMs = (iso: string): number => Date.parse(iso);

function isBefore(a: number, b: number): boolean {
  return a < b;
}

/**
 * 把若干可能重叠的未结算受阻区间合并为"最早起点到最晚终点"的并集跨度，
 * 返回其总时长。已结束区间（endAt 非空）只计算到 endAt；进行中的计算到 now。
 */
export function computeFrozenSpan(
  intervals: readonly FreezeInterval[],
  now: Date,
): FreezeSettlement {
  if (intervals.length === 0) {
    return { durationMs: 0, residualStartAt: null, settledFromAt: '' };
  }

  const nowMs = now.getTime();
  let earliestStart = Infinity;
  let latestEnd = Number.NEGATIVE_INFINITY;

  for (const interval of intervals) {
    const start = toMs(interval.startAt);
    if (Number.isNaN(start)) continue;
    earliestStart = Math.min(earliestStart, start);
    const end = interval.endAt === null ? nowMs : toMs(interval.endAt);
    latestEnd = Math.max(latestEnd, Number.isNaN(end) ? start : end);
  }

  if (earliestStart === Infinity) {
    return { durationMs: 0, residualStartAt: null, settledFromAt: '' };
  }

  // 并集跨度：最早起点 → 最晚终点（覆盖重叠的空窗），仅口径保守不缩水。
  let duration = Math.max(0, latestEnd - earliestStart);

  const remainsOpen = intervals.some((i) => i.endAt === null);
  // 抵消跨零点/极端入参保护
  if (duration < 0) duration = 0;

  return {
    durationMs: duration,
    residualStartAt: remainsOpen
      ? new Date(latestEnd === nowMs ? now : latestEnd).toISOString()
      : null,
    settledFromAt: new Date(earliestStart).toISOString(),
  };
}

/** 比较两个 ISO 时间，帮助用例层做区间并集去重（SRS-SM-ORG-001 重新启用行） */
export function isBeforeIso(a: string, b: string): boolean {
  return isBefore(toMs(a), toMs(b));
}
