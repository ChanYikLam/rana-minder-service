/**
 * 组织与授权 · PostgreSQL 工作单元与共享工具（infrastructure；#68 / ADR-014）。
 *
 * 与 FormUnitOfWork/IdentityUnitOfWork 同构：以 DbAdapter 开启本地事务并建立
 * 最小 RLS 上下文；业务事实在单事务内原子收口（IFC-TX-001）。外部依赖
 * （Casdoor 写入/回读、通知渠道）不纳入本地原子提交（ADR-004 §2.7）。
 */

import type { DbAdapter, RlsScope } from '../../../../shared/db-adapter';
import { orgError } from '../../domain/types';

export class OrgUnitOfWork {
  private current: Awaited<ReturnType<DbAdapter['beginTransaction']>> | null = null;

  constructor(private readonly db: DbAdapter) {}

  /** 当前事务（仓储读写期间有效；缺失即失败关闭，防止无事务提交） */
  get active(): { readonly id: string } | (TransactionLike & NonNullable<unknown>) {
    return this.requireActive();
  }

  private requireActive(): TransactionLike {
    if (this.current === null) {
      throw new Error('OrgUnitOfWork: 无活动事务，禁止脱离事务读写');
    }
    return this.current;
  }

  async run<T>(scope: RlsScope, fn: () => Promise<T>): Promise<T> {
    if (this.current !== null) {
      throw new Error('OrgUnitOfWork: 工作单元不支持嵌套事务');
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

interface TransactionLike {
  readonly id: string;
}

/** 组织域管理面数据：首版统一 unprotected（行隔离由 club_id 过滤承担，见迁移注释） */
export const ORG_RLS_SCOPE: RlsScope = { kind: 'unprotected' };

export interface OrgRow {
  [column: string]: unknown;
}

/** upsert 影响行数为 0 → 并发冲突或行消失，按提交失败收口（IFC-ERR-016） */
export function assertUpsertApplied(rows: readonly unknown[], what: string): void {
  if (rows.length === 0) {
    throw orgError.commitFailed(`${what} 写入失败（并发冲突或行消失，IFC-ERR-016）`);
  }
}
