/**
 * 数据库适配桩（adapters/db/；未连接态失败关闭）。
 *
 * DEP-Q-001/002 首批技术验证锁定前，所有数据库操作一律抛 DbUnavailableError：
 * 不静默成功、不返回伪造数据；业务命令在 UoW 事务边界内失败即整体回滚
 * （ADR-005 最小 RLS 上下文在真实连接层补全）。
 */

import type { DbAdapter, RlsScope, TransactionContext } from '../../shared/db-adapter';

export class DbUnavailableError extends Error {
  constructor(message = '数据库适配未连接（首版桩）') {
    super(message);
    this.name = 'DbUnavailableError';
  }
}

export class NotWiredDbAdapter implements DbAdapter {
  async beginTransaction(): Promise<TransactionContext> {
    throw new DbUnavailableError();
  }

  async commit(_tx: TransactionContext): Promise<void> {
    throw new DbUnavailableError();
  }

  async rollback(_tx: TransactionContext): Promise<void> {
    throw new DbUnavailableError();
  }

  async setRlsContext(_tx: TransactionContext, _scope: RlsScope): Promise<void> {
    throw new DbUnavailableError();
  }

  async clearRlsContext(_tx: TransactionContext): Promise<void> {
    throw new DbUnavailableError();
  }

  async query<T>(_tx: TransactionContext, _sql: string, _params: readonly unknown[]): Promise<T[]> {
    throw new DbUnavailableError();
  }
}