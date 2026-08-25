/**
 * 安全控制独立验证：SEC-CTL-030（日志分层与审计边界）。
 *
 * 权威来源：docs/specification/安全设计与实现级威胁模型-v1.0.md §5、§18；
 * ADR-011 §2.1、AUD-013/014、XCC-GEN-007。
 *
 * 验证路径（真实代码，无 pg/jose 依赖）：
 * - src/platform/observability/audit-link/audit-boundary.ts（整条拒绝语义）
 * - src/platform/observability/domain/services/redaction.rules.ts（值脱敏语义）
 * - src/platform/observability/logging/sanitizer.ts（结构化字段过滤）
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  AuditBoundaryViolation,
  DefaultAuditBoundaryAssert,
} from '../../src/platform/observability/audit-link/audit-boundary';
import { decide, redactRecord } from '../../src/platform/observability/domain/services/redaction.rules';
import { DefaultLogSanitizer } from '../../src/platform/observability/logging/sanitizer';

describe('SEC-CTL-030 审计边界：审计/权限/决策字段禁止进入运行日志层', () => {
  const boundary = new DefaultAuditBoundaryAssert();

  it('SEC-CTL-030：audit.*/permission.*/role.*/authorization.*/decision.* 前缀命中即抛边界违规', () => {
    for (const field of [
      'audit.raw',
      'audit.id',
      'permission.source',
      'role.verdict',
      'authorization.decision',
      'decision.result',
    ]) {
      assert.ok(boundary.isForbidden(field), field);
      assert.throws(() => boundary.assert(field), AuditBoundaryViolation, field);
    }
    assert.doesNotThrow(() => boundary.assert('trace.id'));
    assert.doesNotThrow(() => boundary.assert('http.statusCode'));
  });

  it('SEC-CTL-030：边界支持调用方追加收紧前缀，且默认集保持最小不扩权', () => {
    const tighter = new DefaultAuditBoundaryAssert({
      extraForbiddenPrefixes: [/^secret\./i],
    });
    assert.ok(tighter.isForbidden('secret.material'));
    assert.ok(!boundary.isForbidden('secret.material'), '默认守卫不得擅自扩大范围');
    assert.ok(tighter.isForbidden('audit.raw'), '追加不削弱默认边界');
  });

  it('SEC-CTL-030：分层语义差异——脱敏保留键名遮蔽值，边界则整条拒绝写入', () => {
    const sanitized = new DefaultLogSanitizer().sanitize({ token: 'super-long-token-value' });
    assert.ok('token' in sanitized, '运行日志层允许保留脱敏线索用于排错');

    const masked = sanitized['token'] as string;
    assert.ok(masked.includes('***'), '令牌值必须不可逆遮蔽');
    assert.ok(!masked.includes('super-long-token-value'));

    assert.throws(
      () => new DefaultAuditBoundaryAssert().assert('audit.raw'),
      AuditBoundaryViolation,
      '审计原始负载不属于运行日志该有的字段',
    );
  });
});

describe('SEC-CTL-030 结构化日志脱敏规则', () => {
  it('SEC-CTL-030：报名正文/评语类键整字段丢弃；联系方式与令牌强遮蔽', () => {
    const out = redactRecord({
      'form.responses.essay': '不应出现的正文',
      'comments.content': '内部评语',
      phone: '13800001234',
      'casdoor.clientSecret': 'cs-live-1234567890',
      accessToken: 'eyJhbGciOiJIUzI1NiJ9.payload.signature',
    });
    assert.equal('form.responses.essay' in out, false);
    assert.equal('comments.content' in out, false);

    const phone = out['phone'] as string;
    assert.ok(phone.includes('***') && !phone.includes('13800001234'));
    const secret = out['casdoor.clientSecret'] as string;
    assert.ok(secret.includes('***') && !secret.includes('cs-live-1234567890'));
    const token = out['accessToken'] as string;
    assert.ok(token.includes('***') && !token.includes('signature'));
  });

  it('SEC-CTL-030：路径末段完全遮蔽（BUG-018），前段仅留首字母', () => {
    assert.equal(decide('filePath').kind, 'mask');
    const masked = redactRecord({ path: '/var/lib/postgres/data/base' })['path'] as string;
    assert.ok(masked.endsWith('/***'), '末段资源标识必须全遮蔽');
    assert.ok(!masked.includes('base'));
    assert.ok(masked.startsWith('/v***'), '非末段仅保留首字母');
  });

  it('SEC-CTL-030：安全追踪/状态等白名单键原样保留；其余超长截断', () => {
    const out = redactRecord({
      traceId: 'tr_11111111-2222-3333-4444-555555555555',
      status: 'ACTIVE',
      userId: 'u-1',
      freeText: 'x'.repeat(500),
    });
    assert.equal(out['traceId'], 'tr_11111111-2222-3333-4444-555555555555');
    assert.equal(out['status'], 'ACTIVE');
    assert.equal(out['userId'], 'u-1');
    const truncated = out['freeText'] as string;
    assert.ok(truncated.length < 500);
    assert.match(truncated, /\.\.\.\[truncated\]$/);
  });

  it('SEC-CTL-030：sanitizer 支持 extraOmitKeys 与自定义长度上限进一步收紧', () => {
    const sanitizer = new DefaultLogSanitizer();
    const tightened = sanitizer.sanitize(
      { args: 'payload-that-must-not-log', note: 'y'.repeat(50) },
      { extraOmitKeys: ['args'], maxFieldLength: 10 },
    );
    assert.equal('args' in tightened, false);
    const note = tightened['note'] as string;
    assert.ok(note.length <= 10 + '...[truncated]'.length);
    assert.match(note, /\.\.\.\[truncated\]$/);
  });
});
