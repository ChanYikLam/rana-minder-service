/**
 * TST-NFR-005 / 012 / 013：资源预算常量、故障矩阵完整性与降级范围/禁止伪成功。
 *
 * - TST-NFR-005：上传大小/附件数量/会话有效期等服务端资源硬上限被校验逻辑强制，
 *   支撑 500 并发混合负载下的容量预算；
 * - TST-NFR-012：13 条 SRS-FAIL 故障恢复规则的实现锚点齐备 + 失败分类器覆盖全部
 *   规范化失败类别 + Webhook 默认关闭与伪造/重复拒绝；
 * - TST-NFR-013：降级只影响事实规定的能力——Casdoor 白名单边界、数据库不可写
 *   失败关闭、渠道失败不伪造成功、超限输入被拒且无部分副作用。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { REPO_ROOT } from './nfr-support';
import {
  DEFAULT_PLATFORM_UPLOAD_LIMITS,
  UploadPolicy,
  UploadLimitExceededError,
} from '../../src/modules/file/domain/services/upload-policy';
import {
  DEFAULT_SESSION_TTL_MINUTES,
  MAX_SESSION_TTL_MINUTES,
} from '../../src/modules/file/application/commands/session-ttl';
import {
  validateFormFieldSet,
  type ProfileFieldDirectoryEntry,
} from '../../src/modules/form/domain/services/form-field.validator';
import { InMemoryTransactionOutboxStore } from '../../src/platform/tasks/outbox/in-memory-transactional-outbox';
import { TaskIntentOutbox } from '../../src/platform/tasks/outbox/task-intent-outbox';
import {
  classifyFailure,
  canRetry,
  requiresManualIntervention,
  computeExponentialBackoffMs,
} from '../../src/platform/tasks/retry-policy/retry-policy';
import {
  WEBHOOK_DEFAULT_ENABLED,
  decideWebhookHandling,
} from '../../src/platform/casdoor/domain/webhook-policy';
import {
  DefaultDegradationPolicy,
  DEGRADATION_WINDOW_MS,
} from '../../src/modules/identity/domain/services/degradation.policy';
import { FakeDbAdapter } from '../../src/shared/testing/fake-db-adapter';
import { FormUnitOfWork } from '../../src/modules/form/infrastructure/unit-of-work';

const exists = (rel: string): boolean => fs.existsSync(path.join(REPO_ROOT, rel));

// ---------------------------------------------------------------------------
// TST-NFR-005：服务端资源预算
// ---------------------------------------------------------------------------

describe('TST-NFR-005 服务端资源预算硬上限', () => {
  it('TST-NFR-005: 上传类别大小与字段数量硬上限被策略强制（管理员配置不得放宽）', () => {
    const policy = new UploadPolicy(DEFAULT_PLATFORM_UPLOAD_LIMITS);
    assert.equal(policy.maxSizeFor('PHOTO'), 10 * 1024 * 1024);
    assert.equal(policy.maxSizeFor('VIDEO'), 200 * 1024 * 1024);
    assert.equal(policy.maxSizeFor('GENERIC'), 20 * 1024 * 1024);
    // 超上限声明 → 拒绝（IFC-ERR-006）
    assert.throws(
      () => policy.assertDeclaredSizeWithinLimit('PHOTO', 10 * 1024 * 1024 + 1),
      UploadLimitExceededError,
    );
    assert.doesNotThrow(() => policy.assertDeclaredSizeWithinLimit('PHOTO', 10 * 1024 * 1024));
    // 字段附件数量不得超过平台硬上限 10
    assert.equal(DEFAULT_PLATFORM_UPLOAD_LIMITS.maxFilesPerField, 10);
    assert.throws(() => policy.assertCountWithinLimit(11), UploadLimitExceededError);
    assert.doesNotThrow(() => policy.assertCountWithinLimit(10));
    // 非正数同样拒绝
    assert.throws(
      () => policy.assertDeclaredSizeWithinLimit('GENERIC', 0),
      UploadLimitExceededError,
    );
  });

  it('TST-NFR-005: 上传会话有效期存在默认值与平台硬上限（不可传极大值近似无限期）', () => {
    assert.equal(DEFAULT_SESSION_TTL_MINUTES, 30);
    assert.equal(MAX_SESSION_TTL_MINUTES, 120);
    assert.ok(MAX_SESSION_TTL_MINUTES >= DEFAULT_SESSION_TTL_MINUTES);
  });

  it('TST-NFR-005: 动态表单字段数量上限被服务端校验强制（>200 整体拒绝）', () => {
    const profileDirectory: ProfileFieldDirectoryEntry[] = [];
    const baseField = {
      id: 'field_a',
      type: 'TEXT',
      label: '文本题',
      required: false,
    };
    // 超过 200 个字段 → 在逐字段校验前整体拒绝并携带 fieldErrors
    const tooMany = Array.from({ length: 201 }, (_, i) => ({
      ...baseField,
      id: `field_${String(i).padStart(3, '0')}`,
    }));
    assert.throws(() => validateFormFieldSet(tooMany, profileDirectory), /字段数量超过上限（200）/);
  });

  it('TST-NFR-005: 重试退避按指数计算且封顶，重试次数预算被强制', () => {
    // base=1000ms：attempt 0→1000、1→2000、2→4000；封顶 60_000ms 不再增长
    assert.equal(computeExponentialBackoffMs(0, 1000, 60_000), 1000);
    assert.equal(computeExponentialBackoffMs(1, 1000, 60_000), 2000);
    assert.equal(computeExponentialBackoffMs(2, 1000, 60_000), 4000);
    assert.equal(computeExponentialBackoffMs(30, 1000, 60_000), 60_000);
    // maxAttempts 预算：未达上限可重试；达到即转人工介入
    const maxAttempts = 5;
    for (let attempts = 0; attempts < maxAttempts; attempts++) {
      assert.equal(canRetry(attempts, maxAttempts), true);
      assert.equal(requiresManualIntervention(attempts, maxAttempts), false);
    }
    assert.equal(canRetry(maxAttempts, maxAttempts), false);
    assert.equal(requiresManualIntervention(maxAttempts, maxAttempts), true);
  });
});

// ---------------------------------------------------------------------------
// TST-NFR-012：故障矩阵完整性
// ---------------------------------------------------------------------------

/** SRS-FAIL-001..013 的实现锚点（相对仓库根；缺失即漂移） */
const FAIL_RULE_ANCHORS: ReadonlyArray<{ rule: string; anchors: readonly string[] }> = [
  { rule: 'SRS-FAIL-001', anchors: ['src/modules/identity/domain/services/degradation.policy.ts'] },
  {
    rule: 'SRS-FAIL-002',
    anchors: ['src/modules/identity/domain/state-machines/account-access.state-machine.ts'],
  },
  { rule: 'SRS-FAIL-003', anchors: ['src/modules/identity/domain/models/profile.ts'] },
  { rule: 'SRS-FAIL-004', anchors: ['src/platform/casdoor/application/casdoor-write.service.ts'] },
  { rule: 'SRS-FAIL-005', anchors: ['src/shared/db-adapter.ts'] },
  { rule: 'SRS-FAIL-006', anchors: ['src/modules/file/domain/services/access-policy.ts'] },
  { rule: 'SRS-FAIL-007', anchors: ['src/adapters/mail/smtp-mail.adapter.ts'] },
  {
    rule: 'SRS-FAIL-008',
    anchors: ['src/modules/notification/application/commands/create-notification-fact.command.ts'],
  },
  {
    rule: 'SRS-FAIL-009',
    anchors: ['src/modules/notification/application/commands/apply-kill-switch.command.ts'],
  },
  {
    rule: 'SRS-FAIL-010',
    anchors: ['src/platform/tasks/executors/handlers/export-generation.handler.ts'],
  },
  {
    rule: 'SRS-FAIL-011',
    anchors: ['src/modules/audit/application/commands/execute-deletion-checklist.command.ts'],
  },
  {
    rule: 'SRS-FAIL-012',
    anchors: ['src/modules/audit/application/commands/retention-cleanup.command.ts'],
  },
  { rule: 'SRS-FAIL-013', anchors: ['src/config/config.loader.ts'] },
];

describe('TST-NFR-012 故障矩阵完整性', () => {
  it('TST-NFR-012: 13 条故障恢复规则均有真实实现锚点文件', () => {
    assert.equal(FAIL_RULE_ANCHORS.length, 13);
    for (const entry of FAIL_RULE_ANCHORS) {
      for (const anchor of entry.anchors) {
        assert.ok(exists(anchor), `${entry.rule} 实现锚点不存在: ${anchor}`);
      }
    }
  });

  it('TST-NFR-012: 失败分类器覆盖全部规范化失败类别（不确定/租约/权限/版本/前置/上限）', () => {
    assert.equal(classifyFailure('external UNCERTAIN result'), 'EXTERNAL_UNCERTAIN');
    assert.equal(classifyFailure('LEASE expired during run'), 'LEASE_EXPIRED');
    assert.equal(classifyFailure('PERMISSION denied'), 'PERMISSION_DENIED');
    assert.equal(classifyFailure('VERSION stale write'), 'VERSION_STALE');
    assert.equal(classifyFailure('PRECONDITION rejected'), 'PRECONDITION_REJECTED');
    assert.equal(classifyFailure('RETRY_LIMIT reached'), 'RETRY_LIMIT_EXCEEDED');
    assert.equal(classifyFailure('smtp connection refused'), 'EXTERNAL_FAILED');
  });

  it('TST-NFR-012: Webhook 默认关闭；秘密缺失/不匹配、缺限流、重复事件均被拒绝', () => {
    assert.equal(WEBHOOK_DEFAULT_ENABLED, false);
    const base = {
      enabled: WEBHOOK_DEFAULT_ENABLED,
      staticSecretConfigured: true,
      secretHeaderMatches: true,
      rateLimitAvailable: true,
      dedupSeen: false,
      receivedAt: new Date(0).toISOString(),
      localEventId: 'evt-1',
      objectType: 'USER' as const,
      objectRef: 'u1',
      rawBodyDigest: 'digest',
    };
    // 默认关闭
    const closed = decideWebhookHandling(base);
    assert.equal(closed.allowed, false);
    assert.match(closed.reason, /CAS-EVT-001/);
    assert.equal(closed.envelope, null);
    // 启用但伪造签名 → 拒绝
    assert.equal(
      decideWebhookHandling({ ...base, enabled: true, secretHeaderMatches: false }).allowed,
      false,
    );
    // 缺限流保护 → 拒绝
    assert.equal(
      decideWebhookHandling({ ...base, enabled: true, rateLimitAvailable: false }).allowed,
      false,
    );
    // 重复事件去重 → 拒绝且不重复触发
    assert.equal(decideWebhookHandling({ ...base, enabled: true, dedupSeen: true }).allowed, false);
    // 合法启用路径仅允许非权威刷新提示
    const allowed = decideWebhookHandling({ ...base, enabled: true });
    assert.equal(allowed.allowed, true);
    assert.match(allowed.reason, /非权威刷新提示/);
  });
});

// ---------------------------------------------------------------------------
// TST-NFR-013：降级范围与禁止伪成功
// ---------------------------------------------------------------------------

describe('TST-NFR-013 降级范围与禁止伪成功', () => {
  it('TST-NFR-013: Casdoor 15 分钟窗口内白名单放行、受保护业务拒绝；超窗仅公开页面', () => {
    const policy = new DefaultDegradationPolicy();
    assert.equal(DEGRADATION_WINDOW_MS, 15 * 60 * 1000);
    const degradedSince = new Date('2026-08-25T08:00:00.000Z');
    const within = (min: number): Date => new Date(degradedSince.getTime() + min * 60_000);
    const sessionOk = {
      degradedSince,
      now: within(5),
      sessionAuthenticatedBeforeFailure: true,
    };
    // 白名单：公开页面、本人基础资料只读、编辑既有草稿非附件字段
    assert.equal(policy.evaluate({ ...sessionOk, category: 'PUBLIC_PAGE' }).allowed, true);
    assert.equal(
      policy.evaluate({ ...sessionOk, category: 'OWN_BASIC_PROFILE_READ' }).allowed,
      true,
    );
    assert.equal(
      policy.evaluate({ ...sessionOk, category: 'OWN_EXISTING_DRAFT_EDIT' }).allowed,
      true,
    );
    // 受保护业务在窗内也拒绝
    assert.equal(policy.evaluate({ ...sessionOk, category: 'PROTECTED_BUSINESS' }).allowed, false);
    // 故障前未可信登录的会话不授予白名单
    assert.equal(
      policy.evaluate({
        ...sessionOk,
        sessionAuthenticatedBeforeFailure: false,
        category: 'OWN_BASIC_PROFILE_READ',
      }).allowed,
      false,
    );
    // 超 15 分钟：除公开页面外全部关闭
    const afterWindow = { degradedSince, now: within(16), sessionAuthenticatedBeforeFailure: true };
    assert.equal(policy.evaluate({ ...afterWindow, category: 'PUBLIC_PAGE' }).allowed, true);
    assert.equal(
      policy.evaluate({ ...afterWindow, category: 'OWN_BASIC_PROFILE_READ' }).allowed,
      false,
    );
    assert.equal(
      policy.evaluate({ ...afterWindow, category: 'PROTECTED_BUSINESS' }).allowed,
      false,
    );
  });

  it('TST-NFR-013: 数据库写入事实失败时整体失败关闭——回滚收口、绝不提交假成功', async () => {
    const db = new FakeDbAdapter();
    const uow = new FormUnitOfWork(db);
    await assert.rejects(
      () =>
        uow.run({ kind: 'unprotected' }, async () => {
          throw new Error('database unwritable');
        }),
      /database unwritable/,
    );
    assert.ok(db.events.some((e) => e.startsWith('rollback:')));
    assert.equal(
      db.events.some((e) => e.startsWith('commit:')),
      false,
    );
  });

  it('TST-NFR-013: 外部渠道失败只保留待重试证据，不改变业务结论也不伪造成功', async () => {
    const store = new InMemoryTransactionOutboxStore();
    const outbox = new TaskIntentOutbox(store);
    await outbox.register({
      intentId: 'i-nfr13',
      taskType: 'NOTIFICATION_DELIVERY',
      idempotencyKey: 'k-nfr13',
      scope: { kind: 'PLATFORM' },
      source: { objectType: 'probe', objectId: 'o', version: 1, scope: { kind: 'PLATFORM' } },
      payload: {},
      notBefore: '',
      createdAt: new Date(0).toISOString(),
    });
    let calls = 0;
    const forwarded = await outbox.forwardPending(10, async () => {
      calls += 1;
      throw new Error('mail channel down');
    });
    assert.equal(forwarded, 0);
    assert.equal(calls, 1);
    const pending = await store.listPending(10);
    // 失败留痕待重试，未被标记成功或丢弃
    assert.equal(pending.length, 1);
  });
});
