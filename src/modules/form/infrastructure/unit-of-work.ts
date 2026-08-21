/**
 * 表单域工作单元（infrastructure 层；IFC-TX-001/003/005 原子提交边界）。
 *
 * 与 IdentityUnitOfWork 同构：以 DbAdapter 开启本地事务，建立最小 RLS 单目标
 * 上下文（form 域暂用无目标 GLOBAL 上下文——表单与提交数据的数据隔离在
 * 4.1.2/3.2 组织层细化），业务事实＋幂等回填＋审计同事务提交；外部依赖
 * （资料目录/文件扫描）不纳入本地原子提交（ADR-004 §2.7）。
 */

import type { DbAdapter, RlsScope, TransactionContext } from '../../../shared/db-adapter';

export class FormUnitOfWork {
  private current: TransactionContext | null = null;

  constructor(private readonly db: DbAdapter) {}

  /** 当前事务（用例执行期间有效；缺失即失败关闭，防止无事务提交） */
  get active(): TransactionContext {
    if (this.current === null) {
      throw new Error('FormUnitOfWork: 无活动事务，禁止脱离事务读写');
    }
    return this.current;
  }

  /** 在 RLS 上下文内执行 fn 并原子收口 */
  async run<T>(scope: RlsScope, fn: () => Promise<T>): Promise<T> {
    if (this.current !== null) {
      throw new Error('FormUnitOfWork: 工作单元不支持嵌套事务');
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
