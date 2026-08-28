/**
 * PostgreSQL OIDC nonce/PKCE 载荷存储（infrastructure；修复联调清单 B3）。
 *
 * 背景：进程内内存 nonce 存储在后端重启后未消费的授权请求全部失效，多实例
 * 部署下各实例各自记账必然校验失败。本实现以共享 PostgreSQL 表承载，接口与
 * InMemoryOidcNonceStore 完全一致，经 OIDC_NONCE_STORE 注入位替换即可。
 *
 * 安全语义：
 * - consume 为原子单胜者（UPDATE ... WHERE consumed_at IS NULL AND 未过期
 *   RETURNING payload），重复回调/并发重放只有一个赢家；
 * - 载荷（PKCE code_verifier）仅存服务端，绝不经浏览器通道；
 * - 无主体上下文（登录前流程），使用 unprotected 直连事务，不挂 RLS
 *   （与 PostgresProfileFieldDirectory 同型先例；表内不含个人敏感字段）；
 * - 惰性清理：签发时顺带删除过期超 24h 的行，防表无限增长。
 */

import type { DbAdapter, TransactionContext } from '../../../shared/db-adapter';
import type { OidcNonceStore } from '../interfaces/nest/oidc-nonce-store';
import { DEFAULT_NONCE_TTL_MS } from '../interfaces/nest/oidc-nonce-store';

/** 直连事务 RLS 上下文：登录前流程无主体，表策略放行应用角色。 */
const NONCE_RLS_SCOPE = { kind: 'unprotected' } as const;

interface NonceRow {
  payload: string | null;
}

export class PostgresOidcNonceStore implements OidcNonceStore {
  constructor(private readonly db: DbAdapter) {}

  async issue(nonce: string, ttlMs: number = DEFAULT_NONCE_TTL_MS, payload: string = ''): Promise<void> {
    let tx: TransactionContext | null = null;
    try {
      tx = await this.db.beginTransaction();
      await this.db.setRlsContext(tx, NONCE_RLS_SCOPE);
      // nonce 为服务端随机 UUID；冲突仅在重放攻击/时钟异常时可能出现，静默忽略。
      await this.db.query(
        tx,
        `INSERT INTO oidc_nonce_issues (nonce, payload, expires_at)
         VALUES ($1, $2, now() + make_interval(secs => $3))
         ON CONFLICT (nonce) DO NOTHING`,
        [nonce, payload, ttlMs / 1000],
      );
      // 惰性清理：删除过期超 24h 的行（含已消费），防表无限增长。
      await this.db.query(
        tx,
        `DELETE FROM oidc_nonce_issues WHERE expires_at < now() - interval '24 hours'`,
        [],
      );
      await this.db.commit(tx);
    } catch (error) {
      if (tx !== null) {
        await this.db.rollback(tx).catch(() => undefined);
      }
      throw error;
    } finally {
      if (tx !== null) {
        await this.db.clearRlsContext(tx).catch(() => undefined);
      }
    }
  }

  async consume(nonce: string): Promise<string | null> {
    let tx: TransactionContext | null = null;
    try {
      tx = await this.db.beginTransaction();
      await this.db.setRlsContext(tx, NONCE_RLS_SCOPE);
      // 原子单胜者：仅"未消费且未过期"的行可被置 consumed；RETURNING 取回载荷
      // （PKCE verifier），一次性消费与载荷取回同一语句完成，不可拆分重放。
      const rows = await this.db.query<NonceRow>(
        tx,
        `UPDATE oidc_nonce_issues
            SET consumed_at = now()
          WHERE nonce = $1
            AND consumed_at IS NULL
            AND expires_at > now()
         RETURNING payload`,
        [nonce],
      );
      await this.db.commit(tx);
      if (rows.length === 0) return null;
      return rows[0]?.payload ?? '';
    } catch (error) {
      if (tx !== null) {
        await this.db.rollback(tx).catch(() => undefined);
      }
      throw error;
    } finally {
      if (tx !== null) {
        await this.db.clearRlsContext(tx).catch(() => undefined);
      }
    }
  }
}
