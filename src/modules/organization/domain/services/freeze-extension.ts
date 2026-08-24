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
 * 把若干可能重叠的未结算受阻区间合并为互不重叠的并集，累加实际受阻时长（毫秒）。
 * 已结束区间（endAt 非空）只计算到 endAt；进行中的计算到 now。区间之间的空窗不计入，
 * 与 ORG-028「按实际停用时长顺延」一致（不做跨空窗并集）。
 */
export function computeFrozenSpan(
  intervals: readonly FreezeInterval[],
  now: Date,
): FreezeSettlement {
  if (intervals.length === 0) {
    return { durationMs: 0, residualStartAt: null, settledFromAt: '' };
  }

  const nowMs = now.getTime();

  // 解析并裁剪为 [start, end]（开放区间 end 取 now；非法/倒置区间归零）
  const parsed = intervals
    .map((interval) => {
      const start = toMs(interval.startAt);
      if (Number.isNaN(start)) return null;
      const endRaw = interval.endAt === null ? nowMs : toMs(interval.endAt);
      const end = Number.isNaN(endRaw) ? start : endRaw;
      return start <= end ? ({ start, end } as const) : null;
    })
    .filter((x): x is { start: number; end: number } => x !== null)
    .sort((a, b) => a.start - b.start || a.end - b.end);

  if (parsed.length === 0) {
    return { durationMs: 0, residualStartAt: null, settledFromAt: '' };
  }

  // 合并重叠/相邻区间并累加时长（空窗不计入）
  let duration = 0;
  const earliestStart = parsed[0].start;
  let curStart = parsed[0].start;
  let curEnd = parsed[0].end;
  for (let i = 1; i < parsed.length; i += 1) {
    const { start, end } = parsed[i];
    if (start <= curEnd) {
      curEnd = Math.max(curEnd, end);
    } else {
      duration += curEnd - curStart;
      curStart = start;
      curEnd = end;
    }
  }
  duration += curEnd - curStart;

  const remainsOpen = intervals.some((i) => i.endAt === null);
  return {
    durationMs: Math.max(0, duration),
    // 仍存在未结算（开放）区间时，结算边界为 now；调用方据此重设新的受阻起点
    residualStartAt: remainsOpen ? new Date(nowMs).toISOString() : null,
    settledFromAt: new Date(earliestStart).toISOString(),
  };
}

/** 比较两个 ISO 时间，帮助用例层做区间并集去重（SRS-SM-ORG-001 重新启用行） */
export function isBeforeIso(a: string, b: string): boolean {
  return isBefore(toMs(a), toMs(b));
}
