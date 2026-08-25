/**
 * L5 运维演练门 7：日志分层、保留、脱敏与追踪父子关系（OPS-VER-017）。
 *
 * 锚点语义：日志分层、保留、脱敏和追踪父子关系——策略版本、到期、敏感扫描
 * 和关联图（docs/operations/部署运维与恢复手册-v1.0.md §OPS-VER 表）。
 *
 * 演练方式（真实领域类 + 注入固定时钟，无 I/O）：
 * - DefaultLogSanitizer / redaction.rules：禁止键整字段丢弃、敏感键遮蔽、
 *   路径分段遮蔽、超长截断与业务级追加剔除；
 * - DefaultRetentionExecutor + retention.rules：30/90/180 天分层保留的
 *   归档与清理时点计算（注入 now）；
 * - TraceContextAdapter（AsyncLocalStorage）+ DefaultCorrelation：
 *   父子 trace 关联与"幂等键 ≠ 追踪号"边界。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { DefaultLogSanitizer } from '../../src/platform/observability/logging/sanitizer';
import { DefaultRetentionExecutor } from '../../src/platform/observability/logging/retention';
import {
  decide,
  DEFAULT_TRUNCATE_MAX,
} from '../../src/platform/observability/domain/services/redaction.rules';
import { resolveRetention, isLogTier } from '../../src/platform/observability/domain/services/retention.rules';
import { createTraceContextAdapter } from '../../src/platform/observability/infrastructure/trace-context.adapter';
import { generateTraceId, isTraceId } from '../../src/platform/observability/domain/services/trace-id.generator';
import { DefaultCorrelation } from '../../src/platform/observability/tracing/correlation';

const findings = {
  redactionEnforced: false,
  retentionTiers: false,
  traceParentChild: false,
};

describe('OPS-VER-017 日志分层、保留、脱敏和追踪父子关系演练', () => {
  it('脱敏：秘密键遮蔽、禁止键丢弃、路径分段遮蔽、白名单键原样保留', () => {
    const sanitizer = new DefaultLogSanitizer();
    const out = sanitizer.sanitize({
      password: 'super-secret-value',
      token: 'tok1234567890',
      email: 'alice@example.edu',
      filePath: '/var/lib/postgresql/data/base/16384',
      // 运行日志按扁平点号键承载业务负载（redaction 规则按键名匹配）
      'form.responses.q1': '报名正文不得入日志',
      'attachments.content': 'raw-bytes',
      'audit.raw': 'audit-payload',
      userId: 'user-ops-17',
      status: 'RETRYABLE_FAILED',
    });

    // 强脱敏键：不可逆遮蔽且保留长度线索（>8 字符）
    assert.equal(out['password'], 'supe***[len=18]');
    assert.equal(out['token'], 'tok1***[len=13]');
    assert.equal(out['email'], 'alic***[len=17]');
    // 禁止键：整字段丢弃（正文/附件原始内容/审计原始负载不入运行日志）
    assert.equal(Object.hasOwn(out, 'form.responses.q1'), false);
    assert.equal(Object.hasOwn(out, 'attachments.content'), false);
    assert.equal(Object.hasOwn(out, 'audit.raw'), false);
    // 路径键：分段遮蔽，末段完全隐藏（BUG-018）
    assert.equal(out['filePath'], '/v***/l***/p***/d***/b***/***');
    // 白名单键：运维诊断所需事实原样保留
    assert.equal(out['userId'], 'user-ops-17');
    assert.equal(out['status'], 'RETRYABLE_FAILED');
    findings.redactionEnforced = true;
  });

  it('脱敏策略口径：decide() 三类决策与默认截断上限（200）', () => {
    assert.deepEqual(decide('audit.raw'), { kind: 'omit' });
    assert.deepEqual(decide('database.password'), { kind: 'mask' });
    assert.deepEqual(decide('traceId'), { kind: 'allow' });
    assert.deepEqual(decide('unknownDiagField'), {
      kind: 'truncate',
      max: DEFAULT_TRUNCATE_MAX,
    });

    // 业务级收紧：extraOmitKeys 与 maxFieldLength 截断标记
    const sanitizer = new DefaultLogSanitizer();
    const tightened = sanitizer.sanitize(
      { args: { a: 1 }, detail: 'x'.repeat(300) },
      { extraOmitKeys: ['args'], maxFieldLength: 50 },
    );
    assert.equal(tightened['args'], undefined);
    assert.equal(String(tightened['detail']).endsWith('...[truncated]'), true);
  });

  it('分层保留：30/90/180 天策略下归档与清理时点按注入时钟精确推进', () => {
    const executor = new DefaultRetentionExecutor();
    const now = new Date('2026-08-24T00:00:00.000Z');
    const DAY = 24 * 60 * 60 * 1000;

    // 普通运行日志：30 在线 + 60 归档 = 90 总期；网络/安全日志 ≥6 个月（180）
    assert.deepEqual(resolveRetention('normal'), { onlineDays: 30, archiveDays: 60, totalDays: 90 });
    for (const tier of ['network', 'security'] as const) {
      assert.equal(resolveRetention(tier).totalDays >= 180, true, `${tier} 日志至少 6 个月`);
    }
    assert.equal(isLogTier('normal'), true);
    assert.equal(isLogTier('business'), false);

    assert.equal(executor.nextArchiveAt('normal', now).getTime(), now.getTime() + 30 * DAY);
    assert.equal(executor.nextCleanupAt('normal', now).getTime(), now.getTime() + 90 * DAY);
    assert.equal(executor.nextArchiveAt('security', now).getTime(), now.getTime() + 30 * DAY);
    assert.equal(executor.nextCleanupAt('security', now).getTime(), now.getTime() + 180 * DAY);

    const cleanup = executor.buildCleanupCommand('normal', now);
    assert.equal(cleanup.destination, 'discard');
    assert.equal(cleanup.olderThan.getTime(), now.getTime() - 90 * DAY);
    const archive = executor.buildArchiveCommand('network', now);
    assert.equal(archive.destination, 'archive');
    findings.retentionTiers = true;
  });

  it('追踪父子关系：子上下文继承 parentTraceId；并发根之间互相隔离', () => {
    const adapter = createTraceContextAdapter();

    adapter.runWithNewRoot(() => {
      const parent = adapter.current();
      assert.ok(parent);
      adapter.runWithNewChild(parent!, () => {
        const child = adapter.current();
        assert.notEqual(child!.traceId, parent!.traceId, '子 span 必须有新 traceId');
        assert.equal(child!.parentTraceId, parent!.traceId, '父子关联必须落 parentTraceId');
        // 深层嵌套仍指向同一根
        adapter.runWithNewChild(child!, () => {
          assert.equal(adapter.current()!.parentTraceId, child!.traceId);
        });
      });
    });

    // 根隔离：外层上下文不泄漏进另一个根
    adapter.runWithNewRoot(() => {
      const a = adapter.current();
      adapter.runWithNewRoot(() => {
        const b = adapter.current();
        assert.notEqual(b!.traceId, a!.traceId);
        assert.equal(b!.parentTraceId, undefined);
      });
    });
    assert.equal(adapter.current(), undefined, '根之外无残留上下文');

    // 边界：追踪号与业务幂等键不得混同（XCC-GEN-001）
    const correlation = new DefaultCorrelation();
    const traceId = generateTraceId();
    assert.ok(isTraceId(traceId));
    assert.throws(
      () => correlation.assert({ traceId, idempotencyKey: traceId }),
      (e: unknown) => e instanceof Error && /must not be a trace id/.test(e.message),
    );
    correlation.assert({ traceId, idempotencyKey: 'recruitment:apply-hash01' });
    findings.traceParentChild = true;
  });

  it('演练结论：脱敏/保留分层/追踪关联 三证据齐备（结构化汇总）', () => {
    assert.deepEqual(findings, {
      redactionEnforced: true,
      retentionTiers: true,
      traceParentChild: true,
    });
  });
});
