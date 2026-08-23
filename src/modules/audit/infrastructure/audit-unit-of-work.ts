/**
 * 审计域工作单元（infrastructure 层；IFC-TX-001/003/005 原子提交边界、AUD-003/IFC-TX-006）。
 *
 * 与 FormUnitOfWork/IdentityUnitOfWork 同构：以 DbAdapter 开启本地事务，建立最小
 * RLS 上下文（审计域暂用无目标 GLOBAL 上下文），审计只追加事件同事务提交；审计
 * 写入失败则原命令回滚（关键审计不得静默丢失，也不得异步补写）。
 */

import type { DbAdapter, RlsScope, TransactionContext } from '../../../shared/db-adapter';

export class AuditUnitOfWork {
  private current: TransactionContext | null = null;

  constructor(private readonly db: DbAdapter) {}

  /** 当前事务（审计写入/查询期间有效；缺失即失败关闭，防止脱离事务提交） */
  get active(): TransactionContext {
    if (this.current === null) {
      throw new Error('AuditUnitOfWork: 无活动事务，禁止脱离事务读写');
    }
    return this.current;
  }

  /** 在 RLS 上下文内执行 fn 并原子收口 */
  async run<T>(scope: RlsScope, fn: () => Promise<T>): Promise<T> {
    if (this.current !== null) {
      throw new Error('AuditUnitOfWork: 工作单元不支持嵌套事务');
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
}
