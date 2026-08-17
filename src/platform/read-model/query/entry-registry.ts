import type { ProjectionScope, ProjectionType } from '../contracts';
import type { FilterClause, FilterOperator, RangeValue } from './query-options';

/**
 * 筛选值类型（IFC-QRY-008：入口登记"筛选键/值类型/操作符"）。
 */
export const FilterValueType = {
  STRING: 'string',
  ENUM: 'enum',
  DATE: 'date',
  BOOLEAN: 'boolean',
  UUID: 'uuid',
} as const;

export type FilterValueType = (typeof FilterValueType)[keyof typeof FilterValueType];

/** 操作符白名单（EQ/RANGE；未登记一律拒绝） */
export type { FilterOperator };

/**
 * 筛选键登记（IFC-QRY-008：值类型、操作符、空值语义、权威字段）。
 *
 * 未知键、未知操作符、损坏/跨入口游标必须拒绝，不能静默忽略后返回更宽结果。
 */
export interface FilterKeyDefinition {
  /** 筛选键（入口内唯一） */
  readonly key: string;
  /** 值类型（校验用；不匹配拒绝） */
  readonly valueType: FilterValueType;
  /** 允许的枚举值（valueType=ENUM 时必填；未知枚举值拒绝） */
  readonly allowedValues?: readonly string[];
  /** 操作符白名单（EQ 单值；RANGE 起止，按目录登记） */
  readonly operators: readonly FilterOperator[];
  /** 空值/空集合语义：是否允许显式空值（默认 false：空值拒绝） */
  readonly allowEmpty?: boolean;
  /** 权威字段（来自权威对象哪个字段；登记用途，非可执行路径） */
  readonly authoritativeField: string;
}

/**
 * 入口登记（IFC-QRY-008）。
 *
 * 每个可筛选入口必须登记：稳定入口版本、筛选键/值类型/操作符、空值/空集合、
 * 多值组合、权威字段、作用域、排序、稳定次级键、分页、字段投影、缓存与负向测试。
 * 首版约束：单筛选键（同一查询一个 filter）、排序仅 STABLE_DEFAULT、
 * 分页上限 100、未登记能力一律拒绝。
 */
export interface QueryEntryDefinition {
  /** 稳定入口标识（如 'public-directory' / 'personal-center' / 'club-workbench'） */
  readonly entryId: string;
  /** 稳定入口版本（筛选键/语义变化时递增；游标与入口版本绑定） */
  readonly entryVersion: string; // 'v1'
  /** 投影类型（游标跨投影类型拒绝） */
  readonly projectionType: ProjectionType;
  /** 作用域要求（入口固定的作用域种类；'ANY'=不限） */
  readonly requiredScopeKind: ProjectionScope['kind'] | 'ANY';
  /** 筛选键登记 */
  readonly filterKeys: readonly FilterKeyDefinition[];
  /** 排序白名单（首版仅稳定默认） */
  readonly allowedSorts: readonly 'STABLE_DEFAULT'[];
  /** 分页上限（≤100） */
  readonly maxLimit: number;
  /** 是否允许未认证读取（公开入口） */
  readonly allowAnonymous: boolean;
  /** 字段投影说明（按访问者类型执行的字段集合；具体由投影层实现） */
  readonly fieldProjection: string;
  /** 缓存策略（可重建投影 / 不缓存） */
  readonly cachePolicy: 'REBUILDABLE' | 'NONE';
}

/**
 * 入口登记目录（IFC-QRY-008 合规）。
 *
 * 三个查询入口在模块装配时 register()；查询前经本目录校验：
 * - 未知筛选键 → 拒绝（IFC-ERR-VALIDATION: 未知筛选键）；
 * - 未知操作符 → 拒绝；
 * - 值类型不匹配（含 enum 值不在白名单）→ 拒绝；
 * - 显式空值未登记允许 → 拒绝；
 * - 排序不在白名单 → 拒绝；
 * - 任意 JSONPath/任意表达式 → 首版无此类能力，一律拒绝（filter 结构只允许 key/value/operator）。
 */
export class QueryEntryRegistry {
  private readonly entries = new Map<string, QueryEntryDefinition>();

  register(entry: QueryEntryDefinition): void {
    if (this.entries.has(entry.entryId)) {
      throw new Error(`IFC-ERR-CONFIG: 入口重复登记: ${entry.entryId}`);
    }
    this.entries.set(entry.entryId, entry);
  }

  get(entryId: string): QueryEntryDefinition {
    const entry = this.entries.get(entryId);
    if (entry === undefined) {
      throw new Error(`IFC-ERR-VALIDATION: 未知查询入口: ${entryId}`);
    }
    return entry;
  }

  has(entryId: string): boolean {
    return this.entries.has(entryId);
  }

  list(): readonly QueryEntryDefinition[] {
    return [...this.entries.values()];
  }

  /**
   * 校验入口查询选项（IFC-QRY-008）。
   *
   * @param entryId 入口标识
   * @param scope 查询作用域（校验 requiredScopeKind）
   * @param filter 筛选子句（未登记键/未知操作符/值类型不匹配 → 拒绝）
   * @param sort 排序（白名单外拒绝）
   * @param limit 分页（> maxLimit 拒绝）
   * @param anonymous 是否未认证（allowAnonymous=false 且匿名 → 拒绝）
   */
  assertValidQuery(
    entryId: string,
    scope: ProjectionScope,
    params: {
      filter?: FilterClause;
      sort?: 'STABLE_DEFAULT';
      limit: number;
      anonymous: boolean;
    },
  ): void {
    const entry = this.get(entryId);

    // 作用域要求
    if (entry.requiredScopeKind !== 'ANY' && scope.kind !== entry.requiredScopeKind) {
      throw new Error(`IFC-ERR-VALIDATION: 入口 ${entryId} 要求作用域 ${entry.requiredScopeKind}`);
    }
    // 未认证许可
    if (params.anonymous && !entry.allowAnonymous) {
      throw new Error(`IFC-ERR-FORBIDDEN: 入口 ${entryId} 需要认证`);
    }
    // 分页上限
    if (params.limit <= 0 || params.limit > entry.maxLimit) {
      throw new Error(`IFC-ERR-VALIDATION: limit 必须为 1..${entry.maxLimit}`);
    }
    // 排序白名单
    if (params.sort !== undefined && !entry.allowedSorts.includes(params.sort)) {
      throw new Error(`IFC-ERR-VALIDATION: 未知排序`);
    }
    // 筛选键校验
    if (params.filter !== undefined) {
      this.assertFilter(entry, params.filter);
    }
  }

  private assertFilter(entry: QueryEntryDefinition, filter: FilterClause): void {
    const def = entry.filterKeys.find((f) => f.key === filter.key);
    if (def === undefined) {
      throw new Error(`IFC-ERR-VALIDATION: 未知筛选键 ${filter.key}`);
    }
    if (!def.operators.includes(filter.operator)) {
      throw new Error(`IFC-ERR-VALIDATION: 未知操作符 ${filter.operator}`);
    }
    if (filter.operator === 'RANGE') {
      this.assertRangeValue(def, filter.value as RangeValue);
      return;
    }
    // EQ：单值字符串
    if (typeof filter.value !== 'string') {
      throw new Error(`IFC-ERR-VALIDATION: 筛选键 ${filter.key} 需单值`);
    }
    if (filter.value.length === 0) {
      if (!def.allowEmpty) {
        throw new Error(`IFC-ERR-VALIDATION: 筛选键 ${filter.key} 不允许空值`);
      }
      return;
    }
    // 值类型校验（enum 走白名单；其余按非空字符串放行，精确类型由投影层实现）
    if (def.valueType === FilterValueType.ENUM && def.allowedValues !== undefined) {
      if (!def.allowedValues.includes(filter.value)) {
        throw new Error(`IFC-ERR-VALIDATION: 筛选键 ${filter.key} 的值不在允许集合内`);
      }
    }
  }

  /** RANGE：value 必须是起止对象且至少一端；DATE 值按 ISO 解析校验 */
  private assertRangeValue(def: FilterKeyDefinition, value: RangeValue): void {
    if (typeof value !== 'object' || value === null) {
      throw new Error(`IFC-ERR-VALIDATION: 筛选键 ${def.key} 需起止对象`);
    }
    if (value.from === undefined && value.to === undefined) {
      throw new Error(`IFC-ERR-VALIDATION: 筛选键 ${def.key} 需至少一端起止`);
    }
    for (const [k, v] of [
      ['from', value.from],
      ['to', value.to],
    ] as const) {
      if (v !== undefined && !Number.isFinite(Date.parse(v))) {
        throw new Error(`IFC-ERR-VALIDATION: 筛选键 ${def.key} 的 ${k} 不是合法时间`);
      }
    }
  }
}
