// no-spec-required CLI 迁移入口；runMigrations 逻辑由 test/integration/migrations.spec.ts 真库全量覆盖
/**
 * 数据库迁移执行器（database；BUG-002 修复）。
 *
 * 责任：
 * - 按文件名字典序（时间戳前缀）加载 src/database/migrations 下的全部迁移；
 * - 在 schema_migrations 表中记录已应用版本，实现幂等（重跑安全）；
 * - 每条迁移在独立事务内执行 `up(runner)`，失败即回滚并中断；
 * - 支持 `down` 单条回滚（可选）。
 *
 * 用法（package.json scripts.migrate）：
 *   node -r ts-node/register src/database/migrate.ts
 * 或生产构建后：node dist/database/migrate.js
 *
 * 仅依赖环境变量/配置文件加载数据库连接（与 adapters.module 一致），不接入 Nest DI。
 */

import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { loadConfig } from '../config';
import { PostgresDbAdapter } from '../adapters/db/postgres-db-adapter';
import type { TransactionContext, RlsScope } from '../shared/db-adapter';

/* eslint-disable no-console -- 迁移执行器为 CLI 入口，使用 console 输出进度与错误 */

export interface MigrationQueryRunner {
  query(sql: string, params?: unknown[]): Promise<unknown>;
}

export interface MigrationModule {
  readonly version: string;
  up(runner: MigrationQueryRunner): Promise<void>;
  down?(runner: MigrationQueryRunner): Promise<void>;
}

const MIGRATIONS_DIR = join(__dirname, 'migrations');
const UNPROTECTED: RlsScope = { kind: 'unprotected' };

function loadMigrationModules(): { version: string; mod: MigrationModule }[] {
  if (!existsSync(MIGRATIONS_DIR)) {
    return [];
  }
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^(\d{12,14})_.*\.(ts|js)$/.test(f) && !f.endsWith('.d.ts'))
    .sort();
  const out: { version: string; mod: MigrationModule }[] = [];
  for (const file of files) {
    // 迁移文件以 .ts（ts-node 开发）或 .js（构建后）存在；require 经 ts-node 钩子解析。
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const loaded = require(join(MIGRATIONS_DIR, file)) as MigrationModule;
    const version = file.replace(/\.(ts|js)$/, '');
    out.push({ version, mod: { ...loaded, version } });
  }
  return out;
}

async function withMigrationTx<T>(
  db: PostgresDbAdapter,
  fn: (tx: TransactionContext, runner: MigrationQueryRunner) => Promise<T>,
): Promise<T> {
  const tx = await db.beginTransaction();
  try {
    await db.setRlsContext(tx, UNPROTECTED);
    const result = await fn(tx, {
      query: (sql: string, params?: unknown[]) => db.query(tx, sql, params ?? []),
    });
    await db.commit(tx);
    return result;
  } catch (error) {
    await db.rollback(tx).catch(() => undefined);
    throw error;
  } finally {
    await db.clearRlsContext(tx).catch(() => undefined);
  }
}

async function getAppliedVersions(db: PostgresDbAdapter): Promise<Set<string>> {
  return withMigrationTx(db, async (tx) => {
    await db.query(
      tx,
      `CREATE TABLE IF NOT EXISTS schema_migrations (
         version    text PRIMARY KEY,
         applied_at timestamptz NOT NULL DEFAULT now()
       )`,
      [],
    );
    const rows = await db.query<{ version: string }>(
      tx,
      `SELECT version FROM schema_migrations`,
      [],
    );
    return new Set(rows.map((r) => r.version));
  });
}

export async function runMigrations(db: PostgresDbAdapter): Promise<string[]> {
  const applied = await getAppliedVersions(db);
  const migrations = loadMigrationModules();
  const appliedNow: string[] = [];

  for (const { version, mod } of migrations) {
    if (applied.has(version)) {
      continue;
    }
    await withMigrationTx(db, async (_tx, runner) => {
      await mod.up(runner);
      await runner.query(
        `INSERT INTO schema_migrations (version) VALUES ($1) ON CONFLICT (version) DO NOTHING`,
        [version],
      );
    });
    appliedNow.push(version);
    console.log(`[migrate] applied: ${version}`);
  }

  if (appliedNow.length === 0) {
    console.log('[migrate] no pending migrations');
  }
  return appliedNow;
}

async function main(): Promise<void> {
  const config = loadConfig();
  const db = new PostgresDbAdapter({
    host: config.database.host,
    port: config.database.port,
    database: config.database.name,
    user: config.database.user,
    // loadConfig 已将 *Ref 解析为实际值（config.loader requireField）。
    password: config.database.passwordRef,
    ssl: config.database.ssl,
    sslRejectUnauthorized: config.database.sslRejectUnauthorized,
    schema: config.database.schema,
  });

  try {
    // 统一业务 Schema（ADR-014）：非 public 时先保证 schema 存在，
    // 迁移内裸建表语句经连接级 search_path 落入该 schema。
    const schema = config.database.schema?.trim();
    if (schema && schema.toLowerCase() !== 'public') {
      const tx = await db.beginTransaction();
      try {
        await db.query(tx, `CREATE SCHEMA IF NOT EXISTS "${schema}"`, []);
        await db.commit(tx);
        console.log(`[migrate] schema ready: ${schema}`);
      } catch (err) {
        await db.rollback(tx).catch(() => undefined);
        throw err;
      }
    }
    const applied = await runMigrations(db);
    if (applied.length > 0) {
      console.log(`[migrate] done: ${applied.length} migration(s) applied`);
    }
  } finally {
    await db.onModuleDestroy().catch(() => undefined);
  }
}

// 直接作为脚本运行时执行（作为模块被测试导入时不自动执行）。
if (require.main === module) {
  main().catch((err) => {
    console.error('[migrate] failed:', err);
    process.exitCode = 1;
  });
}
