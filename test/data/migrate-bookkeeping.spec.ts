/**
 * 数据层集成测试 2/3：migrate.ts 簿记正确性（DATA-MIG-book-*，假适配器驱动真实逻辑）。
 *
 * 以 SQL 记录器假适配器（test/data/helpers/migration-recorder.ts）驱动真实
 * runMigrations（经 migrate-loader 惰性装载，本地无 pg 亦可运行），演练：
 * - 全新库 → 按序全部应用且每条恰一次（book-01）；
 * - 重跑 → 零应用、零 up SQL（book-02）；
 * - 逐个逆序 down → up/down SQL 配对对称（语句模式配对＋显式映射表），
 *   清账后可全量重放重建（book-03）；
 * - 中途失败 → 该版本不入账、前序保留、修复后从断点续走（book-04）；
 * - 簿记表现状：无 checksum 列——内容漂移检测未实现（book-05 现状固化）；
 * - 可选真库回环：pg 与 DATABASE_URL 双条件满足才执行，否则 t.skip（real-01）。
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';

import { collectSql, loadManifest } from './helpers/migration-manifest';
import { canResolvePg, loadMigrate } from './helpers/migrate-loader';
import {
  MigrateRecordingDb,
  normalizeSql,
  splitByVersionBlocks,
} from './helpers/migration-recorder';
import type { MigrationEntry } from './helpers/migration-manifest';

const manifest: MigrationEntry[] = loadManifest();
const VERSIONS = manifest.map((e) => e.version);
// 清单版本 = 完整文件名干（migrate.ts 登记口径）；裸时间戳字面量匹配不到任何版本
const NO_OP_STEM =
  VERSIONS.find((v) => v.startsWith('20260820130000_')) ?? '20260820130000（缺失）';
const JOB_TASK_STEM =
  VERSIONS.find((v) => v.startsWith('20260822120000_')) ?? '20260822120000（缺失）';
const migrate = loadMigrate();
const loaderSkip = migrate
  ? false
  : 'migrate.ts 惰性装载失败（依赖链异常），跳过簿记演练——清单/DDL 用例仍在其他文件独立执行';

/** 共享干跑结果：一次全新库完整应用（book-01 的被检对象，也供 book-04 学习注入点） */
let db: MigrateRecordingDb;
let appliedAll: string[];
let dry: ReturnType<typeof splitByVersionBlocks>;

before(async () => {
  if (!migrate) return;
  db = new MigrateRecordingDb();
  appliedAll = await migrate.runMigrations(db);
  dry = splitByVersionBlocks(db.statements);
});

describe('DATA-MIG-book 迁移执行器簿记（SQL 记录器假适配器 × 真实 runMigrations）', () => {
  it('DATA-MIG-book-01: 全新库→按序全部应用且每条恰一次', { skip: loaderSkip }, () => {
    assert.ok(migrate && db && dry);
    // 返回值 = 全部版本、严格按清单顺序
    assert.deepEqual(appliedAll, VERSIONS);

    // 簿记入账：每版本恰一次 INSERT，顺序与清单一致
    const inserts = db.statements.filter((s) =>
      /^INSERT INTO schema_migrations\b/i.test(normalizeSql(s.sql)),
    );
    assert.deepEqual(
      inserts.map((s) => String(s.params[0])),
      VERSIONS,
      'schema_migrations 入账序列应等于迁移清单全序',
    );

    // 每个 up(runner) 恰被执行一次，且各版本块非空（20130000 无操作版除外）
    for (const version of VERSIONS) {
      const block = dry.blocks.get(version);
      assert.ok(block, `版本 ${version} 未产生语句块`);
      assert.equal(block.insertCount, 1, `版本 ${version} 应恰入账一次`);
    }
    // 无操作迁移（20260820130000）仅允许 OPS-UPG-002 升级防线的
    // information_schema 探测 SELECT，不允许任何 DDL（SELECT 不计入 DDL 口径）
    const nonDdlSqls = (sqls: string[]): string[] =>
      sqls.filter((s) => !/^\s*(SELECT|INSERT|UPDATE|DELETE)\b/i.test(normalizeSql(s)));
    assert.ok(NO_OP_STEM.startsWith('2026'), '无操作迁移版本未在清单中找到');
    for (const noOp of [NO_OP_STEM]) {
      assert.deepEqual(
        nonDdlSqls(dry.blocks.get(noOp)?.sqls ?? ['missing']),
        [],
        '无操作迁移不应发出 DDL（升级防线探测 SELECT 不计入）',
      );
    }

    // 事务生命周期：1 个建表探测事务 + N 个迁移事务；全部 commit、零 rollback
    const txCount = VERSIONS.length + 1;
    assert.equal(db.events.filter((e) => e.startsWith('begin:')).length, txCount);
    assert.equal(db.events.filter((e) => e.startsWith('commit:')).length, txCount);
    assert.equal(db.events.filter((e) => e.startsWith('rollback:')).length, 0);
    // 每个事务内建立 unprotected RLS 最小上下文（migrate.ts withMigrationTx）
    assert.equal(
      db.events.filter((e) => e.startsWith('set-rls:') && e.endsWith(':unprotected')).length,
      txCount,
    );
  });

  it('DATA-MIG-book-02: 重跑→零应用、零 up SQL（幂等可重入）', { skip: loaderSkip }, async () => {
    assert.ok(migrate && db);
    const before = db.statements.length;
    const eventsBefore = db.events.length;

    const appliedAgain = await migrate.runMigrations(db);

    assert.deepEqual(appliedAgain, [], '已全部应用时重跑不得再应用任何版本');
    const delta = db.statements.slice(before).map((s) => normalizeSql(s.sql));
    // 仅剩簿记探测语句（CREATE TABLE IF NOT EXISTS + SELECT version）
    assert.equal(delta.length, 2, '重跑只应发生簿记探测两条语句');
    for (const sql of delta) {
      assert.match(sql, /schema_migrations/i);
      assert.doesNotMatch(sql, /^INSERT INTO/i, '重跑不得重复入账');
      assert.doesNotMatch(sql, /CREATE TABLE IF NOT EXISTS (?!schema_migrations)/i);
    }
    // 零迁移事务：无新增 begin（簿记探测自身占用一个事务）
    const newTxs = db.events.slice(eventsBefore).filter((e) => e.startsWith('begin:')).length;
    assert.equal(newTxs, 1, '重跑仅允许一个簿记探测事务');
  });

  it(
    'DATA-MIG-book-03: 逐个逆序 down 与 up SQL 配对对称；清账后可全量重放重建',
    { skip: loaderSkip },
    async () => {
      assert.ok(migrate && db);
      // 显式映射表（读代码后确认的真实非对称点）：
      // - job-task 接管迁移 up 的 DO 块（孤儿复合类型清理 DROP TYPE public.job_tasks）
      //   对称于 down 的显式 DROP TYPE public.job_tasks；
      // - 无操作历史迁移（up 仅探测 SELECT、down 空），两侧零 DDL。
      const PAIR_EXCEPTIONS: Record<string, { up: string; down: string }> = {
        [JOB_TASK_STEM]: { up: 'do-block:job_tasks', down: 'type-drop:job_tasks' },
      };
      const NO_DDL_STEMS = new Set([NO_OP_STEM]);

      /** 多重集消去：两侧共同项两两抵消，返回各自剩余 */
      const cancelCommon = (a: readonly string[], b: readonly string[]): [string[], string[]] => {
        const pool = new Map<string, number>();
        for (const y of b) pool.set(y, (pool.get(y) ?? 0) + 1);
        const restA: string[] = [];
        for (const x of a) {
          const c = pool.get(x) ?? 0;
          if (c > 0) pool.set(x, c - 1);
          else restA.push(x);
        }
        const restB: string[] = [];
        for (const [key, count] of pool) {
          for (let i = 0; i < count; i += 1) restB.push(key);
        }
        return [restA, restB];
      };

      const droppedTablesOf = (downSqls: readonly string[]): Set<string> =>
        new Set(
          downSqls
            .map((s) =>
              /^\s*DROP TABLE (?:IF EXISTS\s+)?public\.(\w+)/i.exec(s)?.[1]?.toLowerCase(),
            )
            .filter((n): n is string => Boolean(n)),
        );

      const indexOwnerOf = (upSqls: readonly string[]): Map<string, string> => {
        const map = new Map<string, string>();
        for (const s of upSqls) {
          const m =
            /^\s*CREATE (?:UNIQUE )?INDEX (?:IF NOT EXISTS\s+)?(\w+)\s+ON (?:public\.)?(\w+)/i.exec(
              s,
            );
          if (m) map.set(m[1].toLowerCase(), m[2].toLowerCase());
        }
        return map;
      };

      /**
       * up 侧规范键：分类后剔除「隐式级联删除」的索引——多数迁移 down 仅删所属表
       * （PostgreSQL 删表连带删索引），不强制显式 DROP INDEX。
       */
      const canonicalUpKeys = (
        upSqls: readonly string[],
        downSqls: readonly string[],
      ): string[] => {
        const dropped = droppedTablesOf(downSqls);
        const owner = indexOwnerOf(upSqls);
        return upSqls
          .map(classifyDdl)
          .filter((k): k is string => k !== null)
          .filter((k) => {
            const m = /^index:(.+)$/.exec(k);
            if (!m) return true;
            const table = owner.get(m[1]);
            return !(table !== undefined && dropped.has(table));
          });
      };

      /** 幂等重入折叠：up 内「先 DROP IF EXISTS 再重建同名对象」产生相邻同键，视为一次操作 */
      const collapseAdjacentDuplicates = (keys: readonly string[]): string[] =>
        keys.filter((k, i) => i === 0 || k !== keys[i - 1]);

      for (const entry of [...manifest].reverse()) {
        const upSqls = await collectSql(entry.mod, 'up');
        const downSqls = await collectSql(entry.mod, 'down');

        if (NO_DDL_STEMS.has(entry.version)) {
          assert.deepEqual(
            canonicalUpKeys(upSqls, downSqls),
            [],
            `${entry.file} 无操作迁移不应有 DDL`,
          );
          continue;
        }

        const upKeys = collapseAdjacentDuplicates(
          upSqls.map(classifyDdl).filter((k): k is string => k !== null),
        );
        const downKeys = collapseAdjacentDuplicates(
          downSqls.map(classifyDdl).filter((k): k is string => k !== null),
        );
        const exception = PAIR_EXCEPTIONS[entry.version];
        if (exception) {
          const ui = upKeys.indexOf(exception.up);
          const di = downKeys.indexOf(exception.down);
          assert.ok(ui >= 0, `${entry.version} 缺少映射表 up 侧 ${exception.up}`);
          assert.ok(di >= 0, `${entry.version} 缺少映射表 down 侧 ${exception.down}`);
          upKeys.splice(ui, 1);
          downKeys.splice(di, 1);
        }

        const [pendingUp, restDown] = cancelCommon(upKeys, downKeys);
        // 剩余 up 项仅允许「索引随所属表级联删除」语义；其余不对称一律失败
        const dropped = droppedTablesOf(downSqls);
        const owner = indexOwnerOf(upSqls);
        // 剩余 up 项允许两类「随表级联」语义：索引随所属表删除；
        // RLS 开关与行策略亦随 DROP TABLE 级联消失（PG 语义），无需显式 down 语句。
        const restUp = pendingUp.filter((k) => {
          const m = /^index:(.+)$/.exec(k);
          if (m) {
            const t = owner.get(m[1]);
            return !(t !== undefined && dropped.has(t));
          }
          const p = /^(?:policy|rls):public\.(\w+)(?:\.\w+)?$/.exec(k);
          if (p) return !dropped.has(p[1]);
          return true;
        });
        assert.deepEqual(restUp, [], `${entry.file} up 侧存在无法配对的 DDL`);
        assert.deepEqual(restDown, [], `${entry.file} down 侧存在无法配对的 DDL`);
      }

      // 清账（操作员 DELETE FROM schema_migrations 语义）→ 全量重放必须可重建
      db.resetLedger();
      const replay = await migrate.runMigrations(db);
      assert.deepEqual(replay, VERSIONS, '清账后重放应重新应用全部版本');
      const replayBlocks = splitByVersionBlocks(db.statements);
      const entryByStem = new Map(manifest.map((e) => [e.version, e]));
      const replayKeys: string[] = [];
      for (const version of VERSIONS) {
        const entry = entryByStem.get(version);
        assert.ok(entry, `清单缺少版本 ${version}`);
        const downSqls = await collectSql(entry.mod, 'down');
        replayKeys.push(...canonicalUpKeys(replayBlocks.blocks.get(version)?.sqls ?? [], downSqls));
      }
      // 重放规范键必须等于「全部版本 up 侧规范键的独立重算全集」
      const expectedCanonical: string[] = [];
      for (const entry of manifest) {
        const upSqlsF = await collectSql(entry.mod, 'up');
        const downSqlsF = await collectSql(entry.mod, 'down');
        expectedCanonical.push(...canonicalUpKeys(upSqlsF, downSqlsF));
      }
      assert.deepEqual(replayKeys.sort(), expectedCanonical.sort(), '重放 DDL 与首次应用不对称');
    },
  );

  it(
    'DATA-MIG-book-04: 中途失败→该版本不入账、前序保留、修复后从断点续走',
    { skip: loaderSkip },
    async () => {
      assert.ok(migrate);
      // 从共享干跑学习注入点（用 before() 冻结的 dry 快照，而非已被 book-03
      // 清账重放污染的活语句流）：选一个"首条 DDL 全程唯一"的中间版本。
      const snapshotNormalized = [
        ...dry.prologueSqls,
        ...[...dry.blocks.values()].flatMap((b) => b.sqls),
      ].map(normalizeSql);
      const mid = Math.floor(VERSIONS.length / 2);
      let targetIndex = -1;
      let targetSql = '';
      for (let offset = 0; offset < VERSIONS.length; offset += 1) {
        for (const idx of [mid + offset, mid - offset]) {
          if (idx < 1 || idx >= VERSIONS.length || targetIndex >= 0) continue;
          const block = dry.blocks.get(VERSIONS[idx]);
          const firstSql = block?.sqls[0] ? normalizeSql(block.sqls[0]) : '';
          if (!firstSql) continue;
          const occurrences = snapshotNormalized.filter((s) => s === firstSql).length;
          if (occurrences === 1) {
            targetIndex = idx;
            targetSql = firstSql;
          }
        }
      }
      assert.ok(targetIndex > 0, '未能选定唯一注入点');

      const failDb = new MigrateRecordingDb();
      failDb.failWhenSql = (normalized) => normalized === targetSql;
      await assert.rejects(() => migrate.runMigrations(failDb), /注入失败（假适配器）/);

      // 该版本不入账、前序版本保留
      const ledger = failDb.ledgerSnapshot();
      assert.ok(
        !ledger.includes(VERSIONS[targetIndex]),
        `失败版本 ${VERSIONS[targetIndex]} 不得入账`,
      );
      assert.deepEqual(ledger, VERSIONS.slice(0, targetIndex), '失败前的版本应全部保留');
      assert.ok(!failDb.statements.some((s) => normalizeSql(s.sql) === targetSql));

      // 失败事务回滚收口：恰一次 rollback，其余 commit
      const begins = failDb.events.filter((e) => e.startsWith('begin:')).length;
      assert.equal(failDb.events.filter((e) => e.startsWith('rollback:')).length, 1);
      assert.equal(failDb.events.filter((e) => e.startsWith('commit:')).length, begins - 1);

      // 修复（解除注入）→ 重跑从断点续走：仅补齐剩余版本，不重复前序
      failDb.failWhenSql = null;
      const resumed = await migrate.runMigrations(failDb);
      assert.deepEqual(resumed, VERSIONS.slice(targetIndex), '修复后应恰好续走剩余版本');
      assert.deepEqual(failDb.ledgerSnapshot(), VERSIONS, '最终簿记应为全集');
      const insertVersions = failDb.statements
        .map((s) => ({ n: normalizeSql(s.sql), p: s.params }))
        .filter((s) => /^INSERT INTO schema_migrations\b/i.test(s.n))
        .map((s) => String(s.p[0]));
      assert.equal(new Set(insertVersions).size, insertVersions.length, '任何版本不得二次入账');
      assert.equal(insertVersions.length, VERSIONS.length);
    },
  );

  it(
    'DATA-MIG-book-05: 簿记表仅 version/applied_at——内容漂移检测未实现（现状固化）',
    { skip: loaderSkip },
    () => {
      assert.ok(dry);
      const createLedger = dry.prologueSqls.find((s) =>
        /CREATE TABLE IF NOT EXISTS schema_migrations/i.test(normalizeSql(s)),
      );
      assert.ok(createLedger, '未观测到 schema_migrations 建表语句');
      const text = normalizeSql(createLedger);
      assert.match(text, /version\s+text\s+PRIMARY\s+KEY/i);
      assert.match(text, /applied_at\s+timestamptz\s+NOT NULL DEFAULT now\(\)/i);
      // 现状：无 checksum/hash 列 ⇒ 已应用版本内容漂移不会被检测。
      // 若未来引入漂移检测，请把本断言改为正向校验 checksum 列与比对行为。
      assert.doesNotMatch(text, /checksum|content_hash|\bhash\b/i);
    },
  );
});

/**
 * up/down SQL 配对的真实机制（读代码后选定）：语句模式分类＋按对象名配对。
 * 覆盖本仓库出现的全部 DDL 形态：
 * CREATE/DROP TABLE、CREATE/DROP INDEX、ADD/DROP CONSTRAINT、ADD/DROP COLUMN、
 * ENABLE/DISABLE RLS、CREATE/DROP POLICY；DO 块与 DROP TYPE 走显式映射表。
 * 返回 null 表示非 DDL（簿记/探测 SELECT 等），不参与配对。
 */
function classifyDdl(rawSql: string): string | null {
  const sql = normalizeSql(rawSql);
  if (/^DO \$\$/i.test(sql)) {
    if (/DROP TYPE IF EXISTS public\.job_tasks/i.test(sql)) return 'do-block:job_tasks';
    return 'do-block:other';
  }
  let m: RegExpExecArray | null;
  m = /^CREATE TABLE (?:IF NOT EXISTS )?(public\.\w+)/i.exec(sql);
  if (m) return `table:${m[1].toLowerCase()}`;
  m = /^DROP TABLE (?:IF EXISTS )?(public\.\w+)/i.exec(sql);
  if (m) return `table:${m[1].toLowerCase()}`;
  m = /^CREATE (?:UNIQUE )?INDEX (?:IF NOT EXISTS )?(?:public\.)?(\w+) ON/i.exec(sql);
  if (m) return `index:${m[1].toLowerCase()}`;
  m = /^DROP INDEX (?:IF EXISTS )?(?:public\.)?(\w+)/i.exec(sql);
  if (m) return `index:${m[1].toLowerCase()}`;
  m = /^ALTER TABLE (public\.\w+) ADD CONSTRAINT (\w+)/i.exec(sql);
  if (m) return `constraint:${m[1].toLowerCase()}.${m[2].toLowerCase()}`;
  m = /^ALTER TABLE (public\.\w+) DROP CONSTRAINT (?:IF EXISTS )?(\w+)/i.exec(sql);
  if (m) return `constraint:${m[1].toLowerCase()}.${m[2].toLowerCase()}`;
  m = /^ALTER TABLE (public\.\w+) ADD COLUMN (?:IF NOT EXISTS )?(\w+)/i.exec(sql);
  if (m) return `column:${m[1].toLowerCase()}.${m[2].toLowerCase()}`;
  m = /^ALTER TABLE (public\.\w+) DROP COLUMN (?:IF EXISTS )?(\w+)/i.exec(sql);
  if (m) return `column:${m[1].toLowerCase()}.${m[2].toLowerCase()}`;
  m = /^ALTER TABLE (public\.\w+) (?:ENABLE|DISABLE) ROW LEVEL SECURITY/i.exec(sql);
  if (m) return `rls:${m[1].toLowerCase()}`;
  m = /^CREATE POLICY (\w+) ON (public\.\w+)/i.exec(sql);
  if (m) return `policy:${m[2].toLowerCase()}.${m[1].toLowerCase()}`;
  m = /^DROP POLICY (?:IF EXISTS )?(\w+) ON (public\.\w+)/i.exec(sql);
  if (m) return `policy:${m[2].toLowerCase()}.${m[1].toLowerCase()}`;
  m = /^DROP TYPE (?:IF EXISTS )?public\.job_tasks/i.exec(sql);
  if (m) return 'type-drop:job_tasks';
  if (/^\s*(SELECT|INSERT|UPDATE|DELETE)\b/i.test(sql)) return null; // 非 DDL
  return `unclassified:${sql.slice(0, 60)}`; // 未知形态显式暴露，防止静默漏配
}

// ---- 可选真库分支：pg 与 DATABASE_URL 双条件探测，满足才跑真实 up/down 回环 ----

const REAL_URL = process.env.DATABASE_URL ?? '';
const realReady = canResolvePg() && REAL_URL.length > 0;
const realSkip = realReady
  ? false
  : '本地 pg 不可解析或未配置 DATABASE_URL，跳过真实 PostgreSQL up/down 回环（假适配器用例已覆盖簿记语义）';

/** down 后必须消失的核心新建表代表（跨模块抽样，含历史纠缠的 job_tasks） */
const CORE_TABLES: readonly string[] = [
  'users',
  'auth_sessions',
  'form_definitions',
  'form_submissions',
  'recruitment_activities',
  'applications',
  'invitations',
  'job_tasks',
  'audit_event',
  'deletion_checklist',
  'joint_activities',
  'org_club_space',
  'config_roots',
  'task_outbox',
];

it(
  'DATA-MIG-real-01: 真实 PostgreSQL 全量 up→簿记核对→逆序 down 回环（临时清场基线）',
  { skip: realSkip, timeout: 120_000 },
  async () => {
    assert.ok(migrate && realReady);
    const req = eval('require') as NodeRequire;
    const pg = req('pg') as {
      Pool: new (c: object) => { connect(): Promise<RealClient>; end(): Promise<void> };
    };
    const pool = new pg.Pool({ connectionString: REAL_URL, connectionTimeoutMillis: 10_000 });
    const client = await pool.connect();
    try {
      // 单连接适配器（结构化满足 runMigrations 消费形状）；RLS 上下文对
      // unprotected 迁移事务为空操作等价（SET LOCAL 仅随事务生效）。
      const adapter = {
        async beginTransaction() {
          await client.query('BEGIN');
          return { id: 'tx-real-loopback' };
        },
        async commit() {
          await client.query('COMMIT');
        },
        async rollback() {
          await client.query('ROLLBACK');
        },
        async setRlsContext(_tx: unknown, scope: { kind: string }) {
          if (scope.kind !== 'unprotected') {
            throw new Error(`真库回环未预期的 RLS scope: ${scope.kind}`);
          }
        },
        async clearRlsContext() {},
        async query(_tx: unknown, sql: string, params: readonly unknown[] = []) {
          const result = await client.query(sql, params as unknown[]);
          return result.rows as unknown[];
        },
      };

      // 清场基线：容忍首次运行无表（逆序 down 忽略错误）+ 移除簿记表
      const runner = {
        query: async (sql: string, params?: unknown[]) => {
          const r = await client.query(sql, params as unknown[]);
          return r.rows;
        },
      };
      for (const entry of [...manifest].reverse()) {
        try {
          await entry.mod.down(runner);
        } catch {
          /* 首次运行可能无表可删 */
        }
      }
      await client.query('DROP TABLE IF EXISTS schema_migrations');

      // 全量 up：返回值与簿记行数一致
      const applied = await migrate.runMigrations(adapter);
      assert.equal(applied.length, VERSIONS.length);
      assert.deepEqual(applied, VERSIONS);
      const counted = await client.query('SELECT count(*)::int AS n FROM schema_migrations');
      assert.equal((counted.rows[0] as { n: number }).n, VERSIONS.length);

      // 重跑零应用
      assert.deepEqual(await migrate.runMigrations(adapter), []);

      // 逆序 down：核心表消失
      for (const entry of [...manifest].reverse()) {
        await entry.mod.down(runner);
      }
      for (const table of CORE_TABLES) {
        const exists = await client.query(`SELECT to_regclass('public.${table}') AS oid`);
        assert.equal(
          (exists.rows[0] as { oid: string | null }).oid,
          null,
          `down 后 public.${table} 应不存在`,
        );
      }
      // 操作员收尾：清理簿记表，不留演练残留
      await client.query('DROP TABLE IF EXISTS schema_migrations');
    } finally {
      client.release();
      await pool.end();
    }
  },
);

interface RealClient {
  query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
  release(): void;
}
