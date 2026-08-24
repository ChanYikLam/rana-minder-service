import type { Watermark } from '../contracts';

/**
 * 数据来源标识。
 *
 * IFC-QRY-009.8：派生数据滞后或不可用时，只能安全回源、转为可追踪
 * 异步任务或明确不可用；不能去掉筛选或作用域，不能静默返回更宽结果。
 */
export const QuerySource = {
  /** 命中有效投影（新鲜度以 watermark 为证，不作为授权依据） */
  PROJECTION: 'PROJECTION',
  /** 投影失效/缺失，本次回源同步重建后返回 */
  REFRESHED: 'REFRESHED',
  /** 明确不可用（回源失败/派生失败；不得冒充新权威结果） */
  UNAVAILABLE: 'UNAVAILABLE',
} as const;

export type QuerySource = (typeof QuerySource)[keyof typeof QuerySource];

/**
 * 派生查询结果（IFC-QRY-004：读取已确认口径及源水位）。
 */
export interface ReadModelQueryResult<TItem> {
  readonly items: readonly TItem[];
  /** 下一页游标（null=无更多） */
  readonly nextCursor: string | null;
  /** 总数（与 items 使用相同授权、RLS、字段和删除谓词） */
  readonly total: number;
  /** 派生水位（新鲜度证据，不作为授权依据） */
  readonly watermark: Watermark | null;
  /** 数据来源 */
  readonly source: QuerySource;
}
