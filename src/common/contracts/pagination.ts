/**
 * 游标分页契约
 *
 * 权威来源：
 * - docs/specification/接口实现规格-v1.0.md §9（API-GEN-008）
 * - docs/specification/接口契约-v1.0.md §4.3（IFC-QRY-008）
 *
 * 约束：
 * - 普通列表统一 { items, nextCursor }。
 * - 后端必须实现真实游标；游标绑定查询入口/版本、规范化筛选摘要、
 *   授权作用域安全等价标识、完整排序键与稳定对象标识。
 * - 未知查询键、操作符、损坏或跨入口复用的游标必须拒绝。
 */

export interface CursorPaginationQuery {
  cursor?: string;
  limit?: number;
}

export interface SearchQuery {
  search?: string;
  q?: string;
}

export interface ListResult<T> {
  items: T[];
  nextCursor: string | null;
}

/** 列表分页的稳定排序约束：完整排序键后追加稳定对象标识次级键 */
export type StableSortableObject = {
  id: string;
};
