import type { ProjectionRecord, ProjectionScope, ProjectionType } from '../contracts';

/** 投影存储注入令牌（ProjectionStore 为接口，注入须用显式 token） */
export const PROJECTION_STORE = Symbol('PROJECTION_STORE');

/**
 * 投影持久化载体（infrastructure 适配实现；首版可替换为 PostgreSQL 或
 * 可重建应用缓存载体，ADR-007）。
 *
 * 只保存可重建派生数据，不承载授权、状态、唯一性或恢复事实
 * （IFC-DATA-012）；全部丢失/过期/清空时必须能从权威来源重建出相同结果。
 */
export interface ProjectionStore {
  /** 保存/更新一个投影记录（幂等覆盖同水位旧值） */
  save<TData>(record: ProjectionRecord<TData>): Promise<void>;

  /** 读取一个作用域下的投影记录；不存在或已失效返回 null */
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
}
