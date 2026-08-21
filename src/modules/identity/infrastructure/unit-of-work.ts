/**
 * 身份域工作单元（infrastructure 层；IFC-TX-001/003/005 原子提交边界）。
 *
 * 职责：以 DbAdapter 开启本地事务，在事务边界内建立并验证最小 RLS 单目标上下文，
 * 成功提交、失败回滚、全部结束路径清理上下文并归还连接（OPS-DB-003 §9.1）。
 * 仓储经本工作单元取得当前事务（ambient transaction），实现"业务事实＋同步意图＋
 * 审计同事务提交"。外部依赖（Casdoor/邮件投递）不纳入本地原子提交（ADR-004 §2.7）。
 */

import type { DbAdapter, RlsScope, TransactionContext } from '../../../shared/db-adapter';

export class IdentityUnitOfWork {
  private current: TransactionContext | null = null;
  private afterCommitCallbacks: Array<() => Promise<void>> = [];

  constructor(private readonly db: DbAdapter) {}

  /** 当前事务（用例执行期间有效；缺失即失败关闭，防止无事务提交） */
  get active(): TransactionContext {
    if (this.current === null) {
      throw new Error('IdentityUnitOfWork: 无活动事务，禁止脱离事务读写');
    }
    return this.current;
  }

  /**
   * 注册事务提交成功后执行的异步动作（外部投递等，ADR-004 §2.7：
   * 外部依赖不纳入本地原子提交）。事务回滚时回调被丢弃、不会执行。
   */
  afterCommit(fn: () => Promise<void>): void {
    this.afterCommitCallbacks.push(fn);
  }

  /** 在单目标 RLS 上下文内执行 fn 并原子收口 */
  async run<T>(scope: RlsScope, fn: () => Promise<T>): Promise<T> {
    if (this.current !== null) {
      throw new Error('IdentityUnitOfWork: 工作单元不支持嵌套事务');
    }
    const tx = await this.db.beginTransaction();
    this.current = tx;
    try {
      await this.db.setRlsContext(tx, scope);
      const result = await fn();
      await this.db.commit(tx);
      await this.flushAfterCommit();
      return result;
    } catch (error) {
      await this.db.rollback(tx).catch(() => undefined);
      throw error;
    } finally {
      this.afterCommitCallbacks = [];
      await this.db.clearRlsContext(tx).catch(() => undefined);
      this.current = null;
    }
  }

  private async flushAfterCommit(): Promise<void> {
    const callbacks = this.afterCommitCallbacks;
    this.afterCommitCallbacks = [];
    for (const callback of callbacks) {
      try {
        await callback();
      } catch (error) {
        // 外部动作失败不改变已提交的业务事实（ADR-004 §2.7），仅记录
        console.error('[IdentityUnitOfWork] after-commit 外部动作执行失败', error);
      }
    }
  }
}
