/**
 * 数据库连通性端口。
 *
 * 路径：src/platform/observability/status-page/（PR #32 §2.2 B）。
 *
 * 接口契约：
 * - ping()：返回 { ok:true, latencyMs } 或 { ok:false, error }。要求不抛异常，
 *   出错即降级为 ok=false（ADR-011：状态页不向用户暴露内部异常）。
 *
 * 首版桩实现 NotWiredDbStatusPort：未连接 src/database/ 时返回 ok=false +
 * 'db-status port not wired (DEP-Q-001 pending)'。状态页展示端会把这条降级
 * 结果显式标注为"未知"。
 *
 * 真实实现在 src/database/ 接入后由 useClass 替换；本 MR 不引入 sql/pg/orm
 * 任何依赖（DEP-Q-001 锁定）。
 */

import type { DbAdapter, TransactionContext } from '../../../shared/db-adapter';

export type DbPingResult =
  | { readonly ok: true; readonly latencyMs: number }
  | { readonly ok: false; readonly error: string };

export interface DbStatusPort {
  ping(): Promise<DbPingResult>;
}

export class NotWiredDbStatusPort implements DbStatusPort {
  async ping(): Promise<DbPingResult> {
    return { ok: false, error: 'db-status port not wired (DEP-Q-001 pending)' };
  }
}

/**
 * 真实 DB 连通性端口（T4）。
 *
 * 基于 DbAdapter 执行一次只读探测（SELECT 1），测量往返时延；
 * 出错时降级为 ok=false 并给出最小错误信息（ADR-011：状态页不向用户暴露
 * 内部异常；来源过期/不可用显示"未知"）。
 */
export class PostgresDbStatusPort implements DbStatusPort {
  constructor(private readonly db: DbAdapter) {}

  async ping(): Promise<DbPingResult> {
    const started = Date.now();
    let tx: TransactionContext | undefined;
    try {
      tx = await this.db.beginTransaction();
      await this.db.setRlsContext(tx, { kind: 'unprotected' });
      await this.db.query<{ one: number }>(tx, 'SELECT 1 AS one', []);
      await this.db.commit(tx);
      return { ok: true, latencyMs: Date.now() - started };
    } catch (err) {
      // 事务已建立但未成功提交时回滚收口，避免连接泄漏（DATA-CON-006）。
      if (tx !== undefined) {
        await this.db.rollback(tx).catch(() => undefined);
      }
      return { ok: false, error: toMinimalError(err) };
    } finally {
      // 对已收口连接为 no-op（pollution guard，DATA-CON-006）。
      if (tx !== undefined) {
        await this.db.clearRlsContext(tx).catch(() => undefined);
      }
    }
  }
}

function toMinimalError(_err: unknown): string {
  // ADR-011 §5 / SEC-BND-004：状态页对错误详情、连接信息、路径和秘密做最小披露，
  // 不向用户暴露原始异常（可能含主机名/端口/连接串等内部细节）。
  return 'db connectivity check failed';
}
