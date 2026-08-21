/**
 * PostgreSQL 真实访问适配（T2）集成测试（L2；真实 PG18，仅 CI/有 docker 时运行）。
 *
 * 覆盖：
 * - beginTransaction/commit/rollback 事务生命周期；
 * - setRlsContext 以 `SET LOCAL` 建立事务级上下文，事务回滚后上下文自动失效；
 * - 未收口事务经 clearRlsContext 兜底回滚并释放连接（污染防护，DATA-CON-006）；
 * - 重复 commit / 已收口后 query 抛错（防误用）。
 *
 * 依赖：test:integration 阶段由 CI 启动 postgres:18 容器并设置
 * DATABASE_HOST=localhost / DATABASE_PORT=5432 / DATABASE_NAME=ranaminder_test /
 * DATABASE_USER=postgres / DATABASE_PASSWORD=ci。本地无 docker 时跳过。
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

import { PostgresDbAdapter } from '../../src/adapters/db/postgres-db-adapter';

function dockerAvailable(): boolean {
  try {
    execFileSync('docker', ['version', '--format', '{{.Server.Version}}'], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

const canRun = dockerAvailable();
// 需真实 PG 才可运行：无 docker 即跳过（不因本机 CI 环境变量误判）。
const skip = !canRun;

const dbConfig = {
  host: process.env.DATABASE_HOST ?? 'localhost',
  port: Number(process.env.DATABASE_PORT ?? 5432),
  database: process.env.DATABASE_NAME ?? 'ranaminder_test',
  user: process.env.DATABASE_USER ?? 'postgres',
  password: process.env.DATABASE_PASSWORD ?? 'ci',
  ssl: false,
};

let adapter: PostgresDbAdapter | null = null;

before(async () => {
  if (skip) return;
  adapter = new PostgresDbAdapter(dbConfig);
});

after(async () => {
  if (adapter) {
    await adapter.onModuleDestroy();
  }
});

describe('PostgresDbAdapter（T2 真实连接）', { skip }, () => {
  it('事务生命周期：begin → query → commit 生效', async () => {
    const db = adapter!;
    const tx = await db.beginTransaction();
    await db.setRlsContext(tx, { kind: 'unprotected' });
    const rows = await db.query<{ one: number }>(tx, 'SELECT 1 AS one', []);
    assert.equal(rows[0].one, 1);
    await db.commit(tx);
  });

  it('rollback 丢弃未提交写入', async () => {
    const db = adapter!;
    // 建临时表验证事务回滚
    const setupTx = await db.beginTransaction();
    await db.query(setupTx, 'CREATE TEMP TABLE t2_demo(id int)', []);
    await db.commit(setupTx);

    const tx = await db.beginTransaction();
    await db.setRlsContext(tx, { kind: 'unprotected' });
    await db.query(tx, 'INSERT INTO t2_demo(id) VALUES ($1)', [42]);
    await db.rollback(tx);

    const readTx = await db.beginTransaction();
    const rows = await db.query<{ id: number }>(readTx, 'SELECT id FROM t2_demo', []);
    assert.equal(rows.length, 0);
    await db.commit(readTx);
  });

  it('未收口事务经 clearRlsContext 兜底回滚并释放连接（污染防护）', async () => {
    const db = adapter!;
    const setupTx = await db.beginTransaction();
    await db.query(setupTx, 'CREATE TEMP TABLE t2_demo2(id int)', []);
    await db.commit(setupTx);

    const tx = await db.beginTransaction();
    await db.query(tx, 'INSERT INTO t2_demo2(id) VALUES ($1)', [7]);
    // 不 commit/rollback，直接 clearRlsContext → 兜底回滚
    await db.clearRlsContext(tx);

    const readTx = await db.beginTransaction();
    const rows = await db.query<{ id: number }>(readTx, 'SELECT id FROM t2_demo2', []);
    assert.equal(rows.length, 0);
    await db.commit(readTx);
  });

  it('重复 commit 抛错；已收口后 query 抛错（防误用）', async () => {
    const db = adapter!;
    const tx = await db.beginTransaction();
    await db.commit(tx);
    await assert.rejects(db.commit(tx));
    await assert.rejects(db.query<{ one: number }>(tx, 'SELECT 1', []));
  });

  it('RLS 上下文随事务提交自动失效（事务级隔离）', async () => {
    const db = adapter!;
    const tx = await db.beginTransaction();
    await db.setRlsContext(tx, { kind: 'single', subjectId: 'u-1' });
    // 事务内 SET LOCAL 上下文生效
    const rows = await db.query<{ ctx: string | null }>(
      tx,
      "SELECT current_setting('app.subject_id', true) AS ctx",
      [],
    );
    assert.equal(rows[0].ctx, 'u-1');
    await db.commit(tx);
    // 提交后事务级上下文失效：新事务不再有 u-1。
    // 注意：SET LOCAL 仅作用于当前事务，提交后回到会话默认值，
    // 而 custom GUC 一旦被 set_config 注册过，会话值即为空串 ''（而非 NULL）。
    const tx2 = await db.beginTransaction();
    const rows2 = await db.query<{ ctx: string | null }>(
      tx2,
      "SELECT current_setting('app.subject_id', true) AS ctx",
      [],
    );
    assert.equal(rows2[0].ctx, '');
    await db.commit(tx2);
  });
});
