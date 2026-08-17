import type { ProjectionRecord, ProjectionScope, ProjectionType } from '../contracts';

/** 投影存储注入令牌（ProjectionStore 为接口，注入须用显式 token） */
export const PROJECTION_STORE = Symbol('PROJECTION_STORE');

/** 保存选项：可选 TTL（过期后 load 视为失效，返回 null） */
export interface SaveOptions {
  /** 存活时长（毫秒）。到期后记录不再作为新鲜结果返回（C2.1 过期语义） */
  readonly ttlMs?: number;
}

/**
 * 投影持久化载体（infrastructure 适配实现；首版可替换为 PostgreSQL 或
 * 可重建应用缓存载体，ADR-007）。
 *
 * 只保存可重建派生数据，不承载授权、状态、唯一性或恢复事实
 * （IFC-DATA-012）；全部丢失/过期/清空时必须能从权威来源重建出相同结果。
 *
 * 覆盖清单 C2.1 四种场景：
 * - 冷缓存：load 返回 null → 调用方回源重建；
 * - 清空：clear() 全量/按类型/按作用域清空；
 * - 过期：save 携带 ttlMs，到期 load 返回 null；
 * - 重建回源：save/load 覆盖同水位旧值。
 */
export interface ProjectionStore {
  /** 保存/更新一个投影记录（幂等覆盖同水位旧值；可选 TTL） */
  save<TData>(record: ProjectionRecord<TData>, options?: SaveOptions): Promise<void>;

  /** 读取一个作用域下的投影记录；不存在、已失效或已过期返回 null */
  load<TData>(
    projectionType: ProjectionType,
    scope: ProjectionScope,
  ): Promise<ProjectionRecord<TData> | null>;

  /** 标记失效（权限收紧/状态变化/停用/联合失效/字段权限变化/正式删除后） */
  invalidate(
    projectionType: ProjectionType,
    scope: ProjectionScope,
    invalidatedAt: string,
    rebuildBasis: string,
  ): Promise<void>;

  /** 按作用域列出投影记录（失效判定/清理用） */
  findByScope<TData>(
    projectionType: ProjectionType,
    scope: ProjectionScope,
  ): Promise<readonly ProjectionRecord<TData>[]>;

  /** 清空投影：省略参数=全部；仅传类型=该类型全部；传类型+作用域=精确作用域 */
  clear(projectionType?: ProjectionType, scope?: ProjectionScope): Promise<void>;
}
