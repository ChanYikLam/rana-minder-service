/**
 * PostgreSQL 访问共享契约（DB 适配边界接口）。
 *
 * 权威来源：src/adapters/db/数据库访问适配文档.md、src/shared/跨模块通用能力文档.md
 * （TransactionContext/RlsContextHelper/DbAdapter/RlsScope 抽象位于本目录，
 * 实现位于 adapters/db/：DbConnectionManager/PostgresTransactionContext/
 * ConnectionContextBuilder/ContextGuard）。
 *
 * 约束：
 * - 每个受保护数据库操作在事务边界内建立、验证并清理最小 RLS 上下文，归还池前证明无残留；
 * - 集合只读上下文禁止写入；客户端提交的社团标识、角色标签、缓存值或旧链接不得成为上下文来源；
 * - 外部依赖不纳入本地原子提交（IFC-TX-*）。
 */

/** 事务边界抽象（业务＋历史＋审计＋通知事实＋任务意图按事务类别原子收口） */
export interface TransactionContext {
  /** 事务唯一标识（用于清理与残留证明） */
  readonly id: string;
}

/** RLS 最小上下文（ADR-005；上下文来源必须是可信服务端身份与业务对象） */
export type RlsScope =
  | { readonly kind: 'single'; readonly subjectId: string }
  | { readonly kind: 'collection-readonly'; readonly scopeKey: string }
  | { readonly kind: 'unprotected' };

/** PostgreSQL 访问适配接口（实现在 adapters/db/） */
export interface DbAdapter {
  beginTransaction(): Promise<TransactionContext>;
  commit(tx: TransactionContext): Promise<void>;
  rollback(tx: TransactionContext): Promise<void>;
  setRlsContext(tx: TransactionContext, scope: RlsScope): Promise<void>;
  clearRlsContext(tx: TransactionContext): Promise<void>;
  query<T>(tx: TransactionContext, sql: string, params: readonly unknown[]): Promise<T[]>;
}