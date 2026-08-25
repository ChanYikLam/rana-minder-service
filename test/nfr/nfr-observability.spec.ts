/**
 * TST-NFR-014 / 024 ~ 029：可见降级与内置异常提示、审计/日志分层、
 * 分层保留与敏感排除、端到端唯一追踪、最小运维状态、完全不可用边界、
 * 观测与自动限制不改变业务结论。
 *
 * - TST-NFR-014：过期状态必须显示未知（stale/unknown 判定），健康汇总降级可见；
 * - TST-NFR-024：业务审计与运行日志分离——运行日志丢弃 audit.raw，审计脱敏器
 *   独立遮蔽凭证；安全日志写入前脱敏序列化；
 * - TST-NFR-025：分层保留策略（普通 30+60=90 天；网络/安全 ≥6 个月）与
 *   报名正文/联系方式/令牌等敏感内容排除；
 * - TST-NFR-026：追踪编号格式唯一且派生关系不编码进编号；错误响应仅暴露 supportId；
 * - TST-NFR-027：状态汇总覆盖 app/db/task/五依赖主题并带更新时间；状态页 fail-closed；
 * - TST-NFR-028：来源缺失/时钟回拨显示未知；备份报告不伪造成功（完全不可用边界）；
 * - TST-NFR-029：观测装饰器只记录事实不改写适配器结果（自动响应不改变业务结论）。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { FIXED_NOW } from './nfr-support';
import {
  DefaultStatusSummaryQueryService,
} from '../../src/platform/observability/status-page/status-summary-query.service';
import {
  DefaultStaleUnknownRule,
} from '../../src/platform/observability/status-page/stale-unknown';
import { DefaultHealthSummaryService } from '../../src/platform/observability/health-summary/health-summary';
import type {
  StatusSummaryQueryService,
  StatusSummaryView,
} from '../../src/platform/observability/status-page/status-summary-query.service';
import type { ExternalResult } from '../../src/common/contracts/external-result';
import {
  DEFAULT_RETENTION_POLICIES,
  resolveRetention,
} from '../../src/platform/observability/domain/services/retention.rules';
import {
  decide,
  redactRecord,
} from '../../src/platform/observability/domain/services/redaction.rules';
import { DefaultLogSanitizer } from '../../src/platform/observability/logging/sanitizer';
import { AuditSanitizer } from '../../src/modules/audit/domain/services/audit-sanitizer';
import {
  NestSecurityLogger,
} from '../../src/platform/observability/logging/security-log';
import {
  generateTraceId,
  isTraceId,
  TRACE_PREFIX,
} from '../../src/platform/observability/domain/services/trace-id.generator';
import { toApiError } from '../../src/modules/identity/interfaces/http/error-http';
import { IdentityCommandError, IdentityErrorCode } from '../../src/modules/identity/application/errors';
import {
  RejectAllStatusPageAuthorizer,
  IdentityStatusPageAuthorizer,
  StatusPageForbiddenError,
} from '../../src/platform/observability/status-page/status-page-authorizer';
import { NestOpsTelemetry } from '../../src/platform/observability/status-page/ops-telemetry';
import { trackNotify } from '../../src/adapters/dep-latest/decorators';

const NOW = FIXED_NOW;

function freshView(): StatusSummaryView {
  const dbData = { ok: true as const, latencyMs: 1 };
  const taskData = { recentFailures: [] };
  const depFresh = {
    state: 'fresh' as const,
    lastCheckedAt: NOW,
    lastResult: 'success' as const,
  };
  return {
    now: NOW,
    app: { version: 'syn', startedAt: NOW, uptimeMs: 0 },
    db: { state: 'fresh', ageMs: 0, data: dbData },
    task: { state: 'fresh', ageMs: 0, data: taskData },
    deps: {
      casdoor: { state: 'fresh', ageMs: 0, data: depFresh },
      mail: { state: 'fresh', ageMs: 0, data: depFresh },
      'file-check': { state: 'fresh', ageMs: 0, data: depFresh },
      notify: { state: 'fresh', ageMs: 0, data: depFresh },
      backup: { state: 'fresh', ageMs: 0, data: depFresh },
    },
  };
}

// ---------------------------------------------------------------------------
// TST-NFR-014：可见降级与内置异常提示
// ---------------------------------------------------------------------------

describe('TST-NFR-014 可见降级与内置异常提示', () => {
  it('TST-NFR-014: 来源过期显示 stale、恢复后回到 fresh（异常与恢复可区分）', () => {
    const rule = new DefaultStaleUnknownRule();
    const stale = rule.evaluate({
      lastCheckedAt: new Date(NOW.getTime() - 10 * 60_000),
      maxAgeMs: 60_000,
      now: NOW,
    });
    assert.equal(stale.state, 'stale');
    assert.ok(stale.ageMs !== undefined && stale.ageMs > 0);
    // 恢复后（时间戳刷新）回到 fresh
    const recovered = rule.evaluate({ lastCheckedAt: NOW, maxAgeMs: 60_000, now: NOW });
    assert.equal(recovered.state, 'fresh');
  });

  it('TST-NFR-014: 任一子系统异常时健康汇总整体 degraded（内置提示可见）', async () => {
    const view = freshView();
    const withMailUnknown: StatusSummaryView = {
      ...view,
      deps: { ...view.deps, mail: { state: 'unknown' } },
    };
    const query: StatusSummaryQueryService = { async execute() { return withMailUnknown; } };
    const summary = await new DefaultHealthSummaryService(query).execute(NOW);
    assert.equal(summary.overall, 'degraded');
    assert.equal(summary.subsystems.find((s) => s.name === 'mail')!.state, 'unknown');
  });
});

// ---------------------------------------------------------------------------
// TST-NFR-024：业务审计与运行日志分离
// ---------------------------------------------------------------------------

describe('TST-NFR-024 业务审计与运行日志分离', () => {
  it('TST-NFR-024: 运行日志整字段丢弃 audit.raw；审计负载由独立脱敏器遮蔽凭证', () => {
    // 运行日志侧：audit.raw 命中禁止清单 → omit（不替代业务审计）
    assert.deepEqual(decide('audit.raw'), { kind: 'omit' });
    const runtimeLog = redactRecord({ 'audit.raw': 'full business payload', traceId: 'tr_x' });
    assert.equal('audit.raw' in runtimeLog, false);
    // 审计侧：AuditSanitizer 对敏感字段只记差异
    const sanitizer = new AuditSanitizer();
    const field = sanitizer.sanitizeField('password', 'plain-secret');
    assert.equal(field.redacted, true);
    assert.match(field.display, /REDACTED/);
    assert.ok(!field.display.includes('plain-secret'));
  });

  it('TST-NFR-024: 网络/安全事件日志写入前完成脱敏序列化（令牌不可原文落盘）', () => {
    const written: string[] = [];
    const logger = new NestSecurityLogger({
      contextName: 'SecurityProbe',
      sanitizer: new DefaultLogSanitizer(),
    });
    // 替换内部 Nest Logger 为捕获探针（仅测试用），验证序列化输出已经脱敏
    const probe = {
      warn(record: unknown): void {
        written.push(typeof record === 'string' ? record : JSON.stringify(record));
      },
      error(): void {},
    };
    (logger as unknown as { logger: unknown }).logger = probe;
    logger.warn({ event: 'auth.failed', token: 'super-secret-token-value', userId: 'u1' });
    assert.equal(written.length, 1);
    assert.ok(!written[0].includes('super-secret-token-value'));
    assert.match(written[0], /\*\*\*/);
  });
});

// ---------------------------------------------------------------------------
// TST-NFR-025：分层保留与敏感内容排除
// ---------------------------------------------------------------------------

describe('TST-NFR-025 分层日志保留与敏感内容排除', () => {
  it('TST-NFR-025: 普通日志 30 在线+60 归档=90 天；网络/安全日志 180 天（≥6 个月下限）', () => {
    assert.deepEqual(DEFAULT_RETENTION_POLICIES.normal, { onlineDays: 30, archiveDays: 60, totalDays: 90 });
    for (const tier of ['network', 'security'] as const) {
      const policy = resolveRetention(tier);
      // ADR-011 §2.1 基线：30 天在线 + 150 天归档 = 180 天，不低于 6 个月下限
      assert.equal(policy.onlineDays, 30);
      assert.equal(policy.totalDays, 180);
      assert.ok(policy.totalDays >= 180);
    }
    // 未知类别按 normal 兜底（不放宽为更长期限）
    assert.deepEqual(resolveRetention('mystery'), DEFAULT_RETENTION_POLICIES.normal);
  });

  it('TST-NFR-025: 报名正文/评语/附件内容被丢弃；完整联系方式与令牌被遮蔽', () => {
    const sanitized = new DefaultLogSanitizer().sanitize({
      'form.responses.q1': '报名正文',
      'evaluation.content': '内部评语',
      'attachments.data': '附件字节',
      phone: '13800001234',
      email: 'student@example.edu',
      accessToken: 'bearer-token-value',
      status: 'SUBMITTED',
    });
    assert.equal('form.responses.q1' in sanitized, false);
    assert.equal('evaluation.content' in sanitized, false);
    assert.equal('attachments.data' in sanitized, false);
    // 完整联系方式被遮蔽（长度 >8 时保留前 4 位 + 长度提示，不落原文）
    assert.notEqual(sanitized.phone, '13800001234');
    assert.match(String(sanitized.phone), /^\d{4}\*\*\*\[len=\d+\]$/);
    assert.notEqual(sanitized.email, 'student@example.edu');
    assert.notEqual(sanitized.accessToken, 'bearer-token-value');
    // 非敏感运维事实原样保留
    assert.equal(sanitized.status, 'SUBMITTED');
  });
});

// ---------------------------------------------------------------------------
// TST-NFR-026：端到端唯一追踪
// ---------------------------------------------------------------------------

describe('TST-NFR-026 端到端唯一追踪', () => {
  it('TST-NFR-026: 追踪编号格式稳定且大规模并发生成不冲突；派生不把父编号编入子编号', () => {
    const count = 2000;
    const ids = Array.from({ length: count }, () => generateTraceId());
    assert.equal(new Set(ids).size, count);
    for (const id of ids) {
      assert.ok(isTraceId(id));
      assert.ok(id.startsWith(TRACE_PREFIX));
    }
    // 派生关系由 parent_id 字段承载：子编号是全新编号，不含父编号片段
    const parent = ids[0];
    const child = generateTraceId();
    assert.ok(isTraceId(child));
    assert.equal(child.includes(parent.slice(TRACE_PREFIX.length)), false);
  });

  it('TST-NFR-026: 用户错误响应只暴露安全支持编号，不携带堆栈或幂等键', () => {
    const result = toApiError(new IdentityCommandError(IdentityErrorCode.FORBIDDEN, '无权限'));
    const keys = Object.keys(result.body).sort();
    assert.deepEqual(keys, ['code', 'message', 'supportId']);
    assert.ok(isTraceId(result.body.supportId));
    // 同一错误两次映射得到不同 supportId（每次请求独立），且都不含错误细节以外的信息
    const second = toApiError(new IdentityCommandError(IdentityErrorCode.FORBIDDEN, '无权限'));
    assert.notEqual(result.body.supportId, second.body.supportId);
    // fieldErrors 仅在结构校验类错误出现
    const validation = toApiError(
      new IdentityCommandError(IdentityErrorCode.VALIDATION_FAILED, 'x', {
        fieldErrors: { phone: ['非法'] },
      }),
    );
    assert.deepEqual(Object.keys(validation.body.fieldErrors ?? {}), ['phone']);
  });
});

// ---------------------------------------------------------------------------
// TST-NFR-027：超级管理员内置最小运维状态
// ---------------------------------------------------------------------------

describe('TST-NFR-027 内置最小运维状态与只读授权', () => {
  it('TST-NFR-027: 状态汇总覆盖应用/数据库/任务/全部外部依赖并携带更新时间', async () => {
    const view = await new DefaultStatusSummaryQueryService(
      { snapshot: () => ({ version: 'syn', startedAt: NOW, uptimeMs: 0 }) },
      { ping: async () => ({ ok: true, latencyMs: 2 }) },
      { summarize: async () => ({ recentFailures: [] }) },
      {
        latest: async () => ({
          state: 'fresh' as const,
          lastCheckedAt: NOW,
          lastResult: 'success' as const,
        }),
      },
    ).execute(NOW);
    assert.equal(view.app.version, 'syn');
    assert.equal(view.db.state, 'fresh');
    assert.equal(view.task.state, 'fresh');
    for (const dep of ['casdoor', 'mail', 'file-check', 'notify', 'backup'] as const) {
      assert.ok(dep in view.deps, `缺少依赖主题 ${dep}`);
      assert.equal(view.deps[dep].state, 'fresh');
    }
  });

  it('TST-NFR-027: 状态页默认拒绝所有访问（fail-closed）；真实授权器核验失败同样拒绝', async () => {
    const strict = new RejectAllStatusPageAuthorizer();
    assert.throws(() => strict.assertSuperAdmin({ userId: 'u1', roles: ['SUPER_ADMIN'] }), StatusPageForbiddenError);
    const identity = new IdentityStatusPageAuthorizer({
      isSuperAdmin: async () => false,
    });
    await assert.rejects(() => identity.assertSuperAdminAsync({ userId: 'u2' }), StatusPageForbiddenError);
    // 未认证主体直接拒绝
    await assert.rejects(() => identity.assertSuperAdminAsync(undefined), StatusPageForbiddenError);
    // 核验器抛错（不可用）→ 失败关闭拒绝，不向状态页泄露内部错误
    const broken = new IdentityStatusPageAuthorizer({
      isSuperAdmin: async () => {
        throw new Error('internal verifier failure');
      },
    });
    await assert.rejects(() => broken.assertSuperAdminAsync({ userId: 'u3' }), StatusPageForbiddenError);
    // 有效超管放行（只读页面入口）
    const okVerifier = new IdentityStatusPageAuthorizer({ isSuperAdmin: async () => true });
    await okVerifier.assertSuperAdminAsync({ userId: 'admin-1' });
  });
});

// ---------------------------------------------------------------------------
// TST-NFR-028：内置异常提示与完全不可用边界
// ---------------------------------------------------------------------------

describe('TST-NFR-028 异常提示与完全不可用边界', () => {
  it('TST-NFR-028: 来源缺失或时钟回拨一律显示未知，不以过期数据伪装健康', () => {
    const rule = new DefaultStaleUnknownRule();
    assert.equal(rule.evaluate({ maxAgeMs: 1000, now: NOW }).state, 'unknown');
    const rollback = rule.evaluate({
      lastCheckedAt: new Date(NOW.getTime() + 60_000),
      maxAgeMs: 1000,
      now: NOW,
    });
    assert.equal(rollback.state, 'unknown');
  });

  it('TST-NFR-028: 全部数据来源未知时整体降级可见；应用完全不可用时无任何自动发现出口', async () => {
    const view = freshView();
    const allSourcesUnknown: StatusSummaryView = {
      ...view,
      db: { state: 'unknown' },
      task: { state: 'unknown' },
      deps: Object.fromEntries(
        Object.keys(view.deps).map((k) => [k, { state: 'unknown' }]),
      ) as StatusSummaryView['deps'],
    };
    const summary = await new DefaultHealthSummaryService({
      async execute() {
        return allSourcesUnknown;
      },
    }).execute(NOW);
    // 应用进程事实仍在（fresh），其余全部未知 → degraded（可见降级）；
    // 应用或宿主机完全不可用时本服务自身不运行——代码中不存在系统外告警/投递出口
    assert.equal(summary.overall, 'degraded');
    const nonApp = summary.subsystems.filter((s) => s.name !== 'app');
    assert.ok(nonApp.every((s) => s.state === 'unknown'));
  });
});

// ---------------------------------------------------------------------------
// TST-NFR-029：观测与自动限制不改变业务结论
// ---------------------------------------------------------------------------

describe('TST-NFR-029 观测事实与业务结论分离', () => {
  it('TST-NFR-029: 依赖观测装饰器透传适配器结果，仅追加最近结果记录', async () => {
    const recorded: Array<{ dep: string; lastResult: string }> = [];
    const recorder = {
      record(entry: { dep: string; lastResult: string }) {
        recorded.push(entry);
      },
    };
    const successResult: ExternalResult<{ externalMessageId: string }> = {
      status: 'SUCCESS',
      data: { externalMessageId: 'ext-1' },
      error: null,
      attemptId: 'att-1',
      timestamp: NOW,
    };
    const baseSend = async (): Promise<ExternalResult<{ externalMessageId: string }>> => successResult;
    const wrapped = trackNotify({ send: baseSend } as never, recorder as never);
    const result = await wrapped.send({
      channel: 'external',
      recipient: 'syn@example.edu',
      templateId: 'tpl-1',
      params: {},
      idempotencyKey: 'k-obs',
    });
    // 业务结果原样返回（未被改写）；观测侧记录同一事实
    assert.equal(result, successResult);
    assert.equal(recorded.length, 1);
    assert.equal(recorded[0].lastResult, 'success');
    // 失败路径：结果照常返回（分类为 failure 记录），不改写业务判定
    const failureResult: ExternalResult<never> = {
      status: 'RETRYABLE_FAILURE',
      data: null,
      error: { code: 'SMTP-DOWN', message: 'smtp down', retryable: true, rawStatusCode: null },
      attemptId: 'att-2',
      timestamp: NOW,
    };
    const failingBase = {
      async send(): Promise<ExternalResult<never>> {
        return failureResult;
      },
    };
    const wrappedFail = trackNotify(failingBase as never, recorder as never);
    const failResult = await wrappedFail.send({
      channel: 'push',
      recipient: 'x@example.edu',
      templateId: 'tpl-1',
      params: {},
      idempotencyKey: 'k-obs-2',
    });
    assert.equal(failResult.status, 'RETRYABLE_FAILURE');
    assert.equal(recorded[recorded.length - 1].lastResult, 'failure');
  });

  it('TST-NFR-029: DB 连通探测只写脱敏运维日志并原样返回探测结果（不做业务处置）', async () => {
    const logs: Array<Record<string, unknown>> = [];
    const telemetry = new NestOpsTelemetry(
      { ping: async () => ({ ok: false, error: 'ECONNREFUSED' }) },
      {
        warn(): void {},
        error(record: Record<string, unknown>) {
          logs.push(record);
        },
      },
    );
    const result = await telemetry.reportDbConnectivity();
    assert.deepEqual(result, { ok: false, error: 'ECONNREFUSED' });
    assert.equal(logs.length, 1);
    assert.equal(logs[0].kind, 'degraded');
    // 只记录错误类别，不带连接串/堆栈
    assert.equal(logs[0].error, 'ECONNREFUSED');
  });
});
