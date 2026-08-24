/**
 * config 域工作单元（infrastructure；原子提交边界，与 RecruitmentUnitOfWork 同构）。
 *
 * 配置事实与留痕按事务原子收口；外部依赖不纳入本地原子提交（ADR-004 §2.7）。
 * 平台级配置（策略表/学年/字段映射/版本线）无社团作用域，统一 unprotected 上下文；
 * 社团展示资料/届次以 collection-readonly scopeKey=clubId 隔离读取、写入走
 * unprotected（3.x RLS 细化前与 recruitment 同口径）。
 */

import type { DbAdapter, RlsScope, TransactionContext } from '../../../shared/db-adapter';

export class ConfigUnitOfWork {
  private current: TransactionContext | null = null;

  constructor(private readonly db: DbAdapter) {}

  get active(): TransactionContext {
    if (this.current === null) {
      throw new Error('ConfigUnitOfWork: 无活动事务，禁止脱离事务读写');
    }
    return this.current;
  }

  async run<T>(scope: RlsScope, fn: () => Promise<T>): Promise<T> {
    if (this.current !== null) {
      throw new Error('ConfigUnitOfWork: 工作单元不支持嵌套事务');
    }
    const tx = await this.db.beginTransaction();
    this.current = tx;
    try {
      await this.db.setRlsContext(tx, scope);
      const result = await fn();
      await this.db.commit(tx);
      return result;
    } catch (error) {
      await this.db.rollback(tx).catch(() => undefined);
      throw error;
    } finally {
      await this.db.clearRlsContext(tx).catch(() => undefined);
      this.current = null;
    }
  }

  /**
   * 仓储内部读写入口：已有活动事务（调用方显式 run 包裹）则复用，保证同一事务
   * 语义；否则自动开启并提交单语句事务。应用命令层不感知事务边界时由此兜底。
   */
  async runShared<T>(scope: RlsScope, fn: () => Promise<T>): Promise<T> {
    if (this.current !== null) {
      return fn();
    }
    return this.run(scope, fn);
  }
}
