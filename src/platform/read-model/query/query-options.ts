/**
 * 查询选项（IFC-QRY-002/008）。
 *
 * 每个可筛选入口必须登记稳定入口版本、筛选键、值类型、操作符、空值/空集合、
 * 多值组合、权威字段、作用域、排序、稳定次级键、分页、字段投影、缓存和负向测试。
 * 未知键、操作符、任意表达式、损坏或跨入口复用的游标必须拒绝，
 * 不能静默忽略后返回更宽结果。
 */
export interface QueryOptions {
  /** 每页上限（服务端封顶） */
  readonly limit: number;
  /** 稳定游标（绑定作用域/筛选/字段；null=第一页） */
  readonly cursor?: string;
  /** 筛选（单键；不允许任意 JSONPath/表达式） */
  readonly filter?: FilterClause;
  /** 排序（首版仅稳定权威默认；展示排序见具体投影） */
  readonly sort?: 'STABLE_DEFAULT';
}

/** 筛选操作符（未登记操作符拒绝；多值/任意表达式后续按目录扩展） */
export type FilterOperator = 'EQ' | 'RANGE';

/** RANGE 操作符的值：起止（至少一个；服务端按平台时区自然日转换） */
export interface RangeValue {
  /** 起始（含） */
  readonly from?: string;
  /** 结束（半开：不含） */
  readonly to?: string;
}

export interface FilterClause {
  /** 已登记的筛选键（未登记键拒绝，不静默忽略） */
  readonly key: string;
  /** 值（EQ：单值字符串；RANGE：起止对象） */
  readonly value: string | RangeValue;
  /** 操作符 */
  readonly operator: FilterOperator;
}
