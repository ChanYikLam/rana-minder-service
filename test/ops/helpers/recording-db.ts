/**
 * L5 运维演练共享假适配器（test/ops 专用）。
 *
 * 实现 src/shared/db-adapter.ts 的 DbAdapter 形状，作为"SQL 记录器"驱动真实类：
 * - 记录事务生命周期事件（begin/commit/rollback/set-rls/clear-rls）与全部查询；
 * - 查询结果按 FIFO 脚本队列回放（enqueueResult），未脚本化时返回空集；
 * - 不引入 pg/jose 依赖链，可在本地无 pg 环境直接运行。
 */

import type { DbAdapter, RlsScope, TransactionContext } from '../../../src/shared/db-adapter';

export class RecordingDbAdapter implements DbAdapter {
  readonly events: string[] = [];
  readonly queries: { sql: string; params: readonly unknown[] }[] = [];
  /** 注入查询故障（模拟 PostgreSQL 断连/超时）；置位后下一次 query 抛错 */
  queryError: Error | null = null;
  private readonly scripted: unknown[][] = [];

  /** 预置下一次 query 的返回行（FIFO；空数组表示空结果集） */
  enqueueResult(rows: unknown[]): void {
    this.scripted.push(rows);
  }

  async beginTransaction(): Promise<TransactionContext> {
    const tx = { id: `tx-${this.events.filter((e) => e.startsWith('begin:')).length + 1}` };
    this.events.push(`begin:${tx.id}`);
    return tx;
  }

  async commit(tx: TransactionContext): Promise<void> {
    this.events.push(`commit:${tx.id}`);
  }

  async rollback(tx: TransactionContext): Promise<void> {
    this.events.push(`rollback:${tx.id}`);
  }

  async setRlsContext(tx: TransactionContext, scope: RlsScope): Promise<void> {
    this.events.push(`set-rls:${tx.id}:${scope.kind}`);
  }

  async clearRlsContext(tx: TransactionContext): Promise<void> {
    this.events.push(`clear-rls:${tx.id}`);
  }

  async query<T>(tx: TransactionContext, sql: string, params: readonly unknown[]): Promise<T[]> {
    this.events.push(`query:${tx.id}`);
    this.queries.push({ sql, params });
    if (this.queryError) {
      const err = this.queryError;
      this.queryError = null;
      throw err;
    }
    return (this.scripted.shift() ?? []) as T[];
  }

  /** 断言辅助：按顺序匹配事件前缀（如 ['begin','set-rls:single','commit','clear-rls']） */
  eventPrefixes(): string[] {
    return this.events.map((e) => e.split(':').slice(0, 2).join(':'));
  }
}
