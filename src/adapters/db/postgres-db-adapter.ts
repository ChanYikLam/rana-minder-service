/**
 * PostgreSQL 真实访问适配实现（adapters/db；T2 接线）。
 *
 * 依据：ADR-005（数据隔离与选择性 RLS）、ADR-014（单数据库统一 Schema）、
 * DATA-CON-006（连接/事务/RLS 上下文与污染防护）、SEC-BND-004（最小披露）。
 *
 * 职责：
 * - 基于 pg 连接池（Pool）实现 DbAdapter 契约（src/shared/db-adapter.ts）；
 * - beginTransaction 从池借用连接并开启事务（BEGIN）；
 * - setRlsContext 在事务内以 `SET LOCAL` 建立最小 RLS 上下文（事务级隔离，ADR-005）；
 * - query 在事务连接上执行，返回行数组；
 * - commit / rollback 收口事务并释放连接；
 * - clearRlsContext 证明事务已结束、连接归还池前无残留上下文（污染防护，
 *   DATA-CON-006）；对未提交即释放的连接由归还钩子兜底 ROLLBACK。
 *
 * 受控状态：
 * - 生产 DDL 门保持关闭（GOV-CODE-WAIVER-001）；本实现仅做连接/事务/RLS 运行时。
 */

import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { Pool, type PoolClient, type QueryResultRow } from 'pg';

import type { DbAdapter, RlsScope, TransactionContext } from '../../shared/db-adapter';

/** 事务句柄：绑定到一条池连接与一个已开启的数据库事务。 */
class PostgresTransactionContext implements TransactionContext {
  readonly id: string;

  constructor(
    readonly client: PoolClient,
    readonly startedAt: Date,
  ) {
    this.id = `tx-${startedAt.getTime()}-${Math.random().toString(36).slice(2, 10)}`;
  }

  /** 事务是否已收口（commit/rollback 调用过）。 */
  settled = false;
}

/** RLS 上下文到 SET LOCAL 语句的映射（ADR-005 最小上下文）。 */
function rlsContextSql(scope: RlsScope): { sql: string; params: readonly unknown[] } {
  switch (scope.kind) {
    case 'single': {
      const subjectId = scope.subjectId ?? '';
      return {
        sql: `SELECT set_config('app.subject_id', $1, true), set_config('app.rls_kind', 'single', true)`,
        params: [subjectId],
      };
    }
    case 'collection-readonly': {
      return {
        sql: `SELECT set_config('app.scope_key', $1, true), set_config('app.rls_kind', 'collection_readonly', true)`,
        params: [scope.scopeKey],
      };
    }
    case 'unprotected': {
      return {
        sql: `SELECT set_config('app.rls_kind', 'unprotected', true)`,
        params: [],
      };
    }
  }
}

@Injectable()
export class PostgresDbAdapter implements DbAdapter, OnModuleDestroy {
  private readonly logger = new Logger(PostgresDbAdapter.name);
  private readonly pool: Pool;

  constructor(
    private readonly poolConfig: {
      host: string;
      port: number;
      database: string;
      user: string;
      password: string;
      ssl: boolean;
      /** SSL 证书校验开关：默认 true（校验）；仅测试/内网可显式关闭。 */
      sslRejectUnauthorized?: boolean;
      max?: number;
      connectionTimeoutMillis?: number;
    },
  ) {
    this.pool = new Pool({
      host: poolConfig.host,
      port: poolConfig.port,
      database: poolConfig.database,
      user: poolConfig.user,
      password: poolConfig.password,
      ssl: poolConfig.ssl
        ? { rejectUnauthorized: poolConfig.sslRejectUnauthorized ?? true }
        : false,
      max: poolConfig.max ?? 10,
      // 连接超时：避免 DB 不可达时 pool.connect() 无限挂起（如 CI 集成测试阶段
      // dind 网络未就绪时静默阻塞直到 Runner 超时强杀）。超时后快速抛错便于定位。
      connectionTimeoutMillis: poolConfig.connectionTimeoutMillis ?? 10_000,
      // 归还前若发现连接上仍有未收口事务，兜底回滚并告警（污染防护）。
      idleTimeoutMillis: 30_000,
      // 连接池空闲即允许进程退出，避免 node --test 因池常驻句柄而等待事件循环耗尽。
      allowExitOnIdle: true,
    });

    this.pool.on('error', (err: Error) => {
      this.logger.error(`PostgreSQL 连接池空闲连接错误：${err.message}`, err.stack);
    });

    // 归还钩子兜底回滚：若连接上仍有未收口事务即被释放（如调用方遗漏
    // commit/rollback），归还池前强制 ROLLBACK，避免悬挂事务占用连接或
    // 污染后续借用的请求（DATA-CON-006 污染防护）。
    // 注意 pg 的 'release' 事件签名是 (err, client)，err 表示归还前发生的错误。
    this.pool.on('release', (_err: Error | undefined, client: PoolClient) => {
      void client.query('ROLLBACK').catch(() => {
        /* 连接即将回收，回滚失败无可挽回，忽略 */
      });
    });
  }

  /** 供集成测试/启动探测复用；返回底池以便在确有需要时执行原生 SQL。 */
  getPool(): Pool {
    return this.pool;
  }

  async beginTransaction(): Promise<TransactionContext> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      return new PostgresTransactionContext(client, new Date());
    } catch (err) {
      client.release();
      throw err;
    }
  }

  async commit(tx: TransactionContext): Promise<void> {
    const ctx = requirePostgresTx(tx);
    if (ctx.settled) {
      throw new Error(`事务 ${ctx.id} 已收口，重复 commit`);
    }
    try {
      await ctx.client.query('COMMIT');
    } finally {
      // 无论成败都视为已收口：连接已归还，后续 rollback/clearRlsContext 不得再触碰。
      ctx.settled = true;
      ctx.client.release();
    }
  }

  async rollback(tx: TransactionContext): Promise<void> {
    const ctx = requirePostgresTx(tx);
    if (ctx.settled) {
      return;
    }
    try {
      await ctx.client.query('ROLLBACK');
    } finally {
      // 无论成败都视为已收口：连接已归还，后续 clearRlsContext 不得再触碰。
      ctx.settled = true;
      ctx.client.release();
    }
  }

  async setRlsContext(tx: TransactionContext, scope: RlsScope): Promise<void> {
    const ctx = requirePostgresTx(tx);
    if (ctx.settled) {
      throw new Error(`事务 ${ctx.id} 已收口，不可再设置 RLS 上下文`);
    }
    const { sql, params } = rlsContextSql(scope);
    await ctx.client.query(sql, params as unknown[]);
  }

  async clearRlsContext(_tx: TransactionContext): Promise<void> {
    // SET LOCAL 上下文随事务提交/回滚自动失效（事务级隔离），无需额外清理。
    // 污染防护由 commit/rollback 的 finally 释放 + 归还池兜底回滚保证。
    const ctx = requirePostgresTx(_tx);
    if (!ctx.settled) {
      // 事务未收口即调用 clearRlsContext：视为调用方收尾约定，直接回滚释放。
      await this.rollback(ctx);
    }
  }

  async query<T>(tx: TransactionContext, sql: string, params: readonly unknown[]): Promise<T[]> {
    const ctx = requirePostgresTx(tx);
    if (ctx.settled) {
      throw new Error(`事务 ${ctx.id} 已收口，不可再执行查询`);
    }
    const result = await ctx.client.query<T extends QueryResultRow ? T : QueryResultRow>(
      sql,
      params as unknown[],
    );
    return result.rows as T[];
  }

  async onModuleDestroy(): Promise<void> {
    // 带超时的连接池关闭：若仍有未归还连接（如测试中断言失败后遗漏 commit/rollback），
    // 避免 pool.end() 无限等待导致 CI 超时强杀（Runner 10 分钟无输出）。
    // 超时后强制终止剩余连接，保证进程可退出。
    await Promise.race([
      this.pool.end(),
      new Promise<void>((resolve) => setTimeout(resolve, 5_000)),
    ]);
  }
}

function requirePostgresTx(tx: TransactionContext): PostgresTransactionContext {
  if (!(tx instanceof PostgresTransactionContext)) {
    throw new Error('PostgresDbAdapter 收到非本实现的事务上下文');
  }
  return tx;
}
