/**
 * 文件域工作单元（infrastructure 层；原子提交边界，与 RecruitmentUnitOfWork 同构）。
 *
 * 业务事实 + 历史按事务原子收口；外部依赖（对象存储/检查服务）不纳入本地原子提交
 * （ADR-008 §2.7）。文件数据隔离在组织/身份授权落地后细化，首版用 unprotected 上下文。
 */

import type { DbAdapter, RlsScope, TransactionContext } from '../../../shared/db-adapter';

export class FileUnitOfWork {
  private current: TransactionContext | null = null;

  constructor(private readonly db: DbAdapter) {}

  get active(): TransactionContext {
    if (this.current === null) {
      throw new Error('FileUnitOfWork: 无活动事务，禁止脱离事务读写');
    }
    return this.current;
  }

  async run<T>(scope: RlsScope, fn: () => Promise<T>): Promise<T> {
    if (this.current !== null) {
      throw new Error('FileUnitOfWork: 工作单元不支持嵌套事务');
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
