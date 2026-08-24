/**
 * 集成测试 L2：数据库迁移全量校验（P2 零覆盖补测：src/database/migrations）。
 *
 * 覆盖：
 * - 全部 15 个迁移按序 up 成功（建表/加列 SQL 在真实 PG18 上可执行）
 * - 幂等可重入：全量 up 重跑一遍不抛错（IF NOT EXISTS 语义）
 * - 建表类迁移的表真实存在（to_regclass 核对）
 * - down 可执行且核心新建表被移除；随后恢复全量 up（不影响其他集成套件）
 *
 * 运行方式与 pg18.spec.ts 一致：需 docker pg18-ci 容器；本地无 docker 时跳过。
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { before, after, test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';

const CI = process.env.CI === 'true';
const DB_NAME = process.env.PGTEST_DB ?? 'ranaminder_test';

function dockerAvailable(): boolean {
  try {
    execFileSync('docker', ['version', '--format', '{{.Server.Version}}'], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

const canRun = dockerAvailable();
const skipReason = !canRun && !CI ? '本地未检测到 docker，跳过 PG18 迁移集成测试' : false;

type Migration = {
  up: (runner: { query: (sql: string) => Promise<unknown> }) => Promise<void>;
  down: (runner: { query: (sql: string) => Promise<unknown> }) => Promise<void>;
};

import * as mIdentity from '../../src/database/migrations/20260820100000_create-identity-tables';
import * as mNameCorr from '../../src/database/migrations/20260820120000_create-name-correction-and-auth-tables';
import * as mJobTasksOld from '../../src/database/migrations/20260820130000_create-job-tasks-table';
import * as mFormDef from '../../src/database/migrations/20260820140000_create-form-definition-tables';
import * as mFormSub from '../../src/database/migrations/20260821100000_create-form-submission-tables';
import * as mRecruit from '../../src/database/migrations/20260822000000_create-recruitment-tables';
import * as mAdmitted from '../../src/database/migrations/20260822000001_add-admitted-accepted-status';
import * as mRevision from '../../src/database/migrations/20260822000002_add-revision-numbers';
import * as mChannelLimits from '../../src/database/migrations/20260822000003_add-channel-choice-limits';
import * as mInterviewHold from '../../src/database/migrations/20260822000004_fix-interview-status-hold';
import * as mPathUnique from '../../src/database/migrations/20260822000005_add-department-path-unique';
import * as mFormUnique from '../../src/database/migrations/20260822000006_add-form-submission-unique';
import * as mJobTasksNew from '../../src/database/migrations/20260822120000_create-job-task-tables';
import * as mInvitation from '../../src/database/migrations/20260822100000_create-invitation-tables';
import * as mAudit from '../../src/database/migrations/20260823000000_create-audit-event-tables';
import * as mDeletionChecklist from '../../src/database/migrations/20260823120000_create-deletion-checklist-tables';
import * as mJoint from '../../src/database/migrations/20260823130000_create-joint-tables';

const migrations: Array<{ name: string; m: Migration }> = [
  { name: '20260820100000', m: mIdentity },
  { name: '20260820120000', m: mNameCorr },
  { name: '20260820130000', m: mJobTasksOld },
  { name: '20260820140000', m: mFormDef },
  { name: '20260821100000', m: mFormSub },
  { name: '20260822000000', m: mRecruit },
  { name: '20260822000001', m: mAdmitted },
  { name: '20260822000002', m: mRevision },
  { name: '20260822000003', m: mChannelLimits },
  { name: '20260822000004', m: mInterviewHold },
  { name: '20260822000005', m: mPathUnique },
  { name: '20260822000006', m: mFormUnique },
  { name: '20260822100000', m: mInvitation },
  { name: '20260822120000', m: mJobTasksNew },
  { name: '20260823000000-audit', m: mAudit },
  { name: '20260823120000-deletion-checklist', m: mDeletionChecklist },
  { name: '20260823130000-joint', m: mJoint },
];

/**
 * 迁移时间戳前缀唯一（未来版本登记工具按前缀编号，冲突会失败；评审 info）。
 * 直接从文件系统扫描全部迁移文件断言唯一性——不依赖上方列表是否完整，
 * 避免"列表内唯一但文件系统前缀已重复"漏检。
 */
const MIG_DIR = path.resolve(__dirname, '../../src/database/migrations');
const ALL_MIGRATION_PREFIXES = fs
  .readdirSync(MIG_DIR)
  .filter((f) => /^20\d{12}_[\w-]+\.ts$/.test(f))
  .map((f) => f.slice(0, 14))
  .sort();
const MIGRATION_VERSION_UNIQUE =
  new Set(ALL_MIGRATION_PREFIXES).size === ALL_MIGRATION_PREFIXES.length;
/** 测试列表必须与文件系统迁移一一对应（缺登即失败，评审 info） */
const MISSING_FROM_TEST = ALL_MIGRATION_PREFIXES.filter(
  (p) => !migrations.some((m) => m.name.startsWith(p)),
);

/** 建表类迁移 → 声明的表；加列/约束类为空 */
const EXPECTED_TABLES: ReadonlyArray<{ file: string; tables: readonly string[] }> = [
  {
    file: '20260820100000',
    tables: [
      'users',
      'identity_profiles',
      'profile_sync_intents',
      'email_verification_requests',
      'account_access',
      'identity_audit',
    ],
  },
  {
    file: '20260820120000',
    tables: ['name_correction_requests', 'auth_reauth_evidence', 'auth_sessions'],
  },
  { file: '20260820130000', tables: [] },
  {
    file: '20260820140000',
    tables: [
      'form_definitions',
      'form_versions',
      'form_preview_tests',
      'form_template_publications',
      'form_audit',
      'form_idempotency',
    ],
  },
  { file: '20260821100000', tables: ['form_submissions'] },
  {
    file: '20260822000000',
    tables: [
      'recruitment_activities',
      'application_channels',
      'applications',
      'department_paths',
      'interview_records',
    ],
  },
  { file: '20260822000001', tables: [] },
  { file: '20260822000002', tables: [] },
  { file: '20260822000003', tables: [] },
  { file: '20260822000004', tables: [] },
  { file: '20260822000005', tables: [] },
  { file: '20260822000006', tables: [] },
  { file: '20260822100000', tables: ['invitations', 'routine_invitations'] },
  { file: '20260822120000', tables: ['job_tasks'] },
  { file: '20260823000000-audit', tables: ['audit_event'] },
  { file: '20260823120000-deletion-checklist', tables: ['deletion_checklist'] },
  {
    file: '20260823130000-joint',
    tables: [
      'joint_activities',
      'joint_participants',
      'joint_applications',
      'joint_interviews',
      'joint_conclusions',
      'joint_channels',
    ],
  },
];

/** down 后必须消失的核心新建表（每条建表链取代表，避免双 job_tasks 历史纠缠） */
const MUST_DROP_AFTER_DOWN: readonly string[] = [
  'audit_event',
  'joint_activities',
  'form_definitions',
  'recruitment_activities',
  'form_submissions',
  'invitations',
  'deletion_checklist',
  // job_tasks：本次幂等化改造影响最大的表（20130000 无操作、22120000 接管），
  // down/恢复行为必须显式断言（评审 info）
  'job_tasks',
];

let pool: pg.Pool | null = null;
let client: pg.PoolClient | null = null;

async function q(sql: string): Promise<unknown> {
  assert.ok(client, 'client not ready');
  return client.query(sql);
}

const runner = { query: (sql: string) => q(sql) };

async function tableExists(name: string): Promise<boolean> {
  const r = (await q(`SELECT to_regclass('public.${name}') AS oid`)) as pg.QueryResult;
  return r.rows[0]?.oid !== null;
}

async function runAllUps(): Promise<void> {
  for (const { m } of migrations) await m.up(runner);
}

before(async () => {
  if (!canRun) {
    if (CI) throw new Error('CI=true 但 docker 不可用，无法执行迁移集成测试');
    return;
  }
  pool = new pg.Pool({
    host: 'localhost',
    port: 5432,
    user: 'postgres',
    password: 'ci',
    database: DB_NAME,
  });
  client = await pool.connect();
});

after(async () => {
  client?.release();
  await pool?.end();
});

test('迁移版本时间戳前缀唯一（文件系统级扫描，不依赖列表完整性）', () => {
  assert.equal(MIGRATION_VERSION_UNIQUE, true, '文件系统存在时间戳前缀相同的迁移，需错开版本号');
});

test('测试列表覆盖全部迁移文件（缺登即失败，防"全量"名不副实）', () => {
  assert.deepEqual(MISSING_FROM_TEST, [], '以下迁移前缀未登记进测试列表，需补登');
  // 反向：测试列表不得登记文件系统不存在的迁移
  const registered = migrations.map((m) => m.name.split('-')[0]);
  const onDisk = new Set(ALL_MIGRATION_PREFIXES);
  const ghost = registered.filter((p) => !onDisk.has(p));
  assert.deepEqual(ghost, [], '测试列表登记了文件系统不存在的迁移前缀');
});

test('全部迁移按序 up 成功且建表齐全；重复 up 幂等可重入', { skip: skipReason }, async () => {
  if (!canRun) return;
  // 清场：先按逆序 down 一遍，保证从干净基线开始（容忍不存在错误）
  for (const { m } of [...migrations].reverse()) {
    try {
      await m.down(runner);
    } catch {
      /* 首次运行可能无表可删 */
    }
  }
  await runAllUps();
  for (const { file, tables } of EXPECTED_TABLES) {
    for (const t of tables) {
      assert.ok(await tableExists(t), `${file} 应创建 public.${t}`);
    }
  }
  // 幂等：全量重跑一遍不得抛错
  await runAllUps();
});

test(
  'down 可执行并移除核心新建表；随后恢复全量 up（不污染其他套件）',
  { skip: skipReason },
  async () => {
    if (!canRun) return;
    for (const { m } of [...migrations].reverse()) await m.down(runner);
    for (const t of MUST_DROP_AFTER_DOWN) {
      assert.equal(await tableExists(t), false, `down 后 ${t} 应不存在`);
    }
    // 恢复：后续集成套件依赖这些表
    await runAllUps();
    for (const t of MUST_DROP_AFTER_DOWN) {
      assert.equal(await tableExists(t), true, `恢复后 ${t} 应存在`);
    }
  },
);
