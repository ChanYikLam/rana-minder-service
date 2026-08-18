import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  DefaultCorrelation,
  CorrelationDistinctViolation,
} from './correlation';
import { generateTraceId } from '../domain/services/trace-id.generator';

describe('correlation (DefaultCorrelation / XCC-GEN-001)', () => {
  const corr = new DefaultCorrelation();

  it('合法 traceId + 无 idempotencyKey 通过', () => {
    const traceId = generateTraceId();
    corr.assert({ traceId });
  });

  it('合法 traceId + 合法 idempotencyKey 通过', () => {
    corr.assert({ traceId: generateTraceId(), idempotencyKey: 'recruitment:apply:abc123' });
  });

  it('idempotencyKey 为 traceId 抛 CorrelationDistinctViolation', () => {
    const traceId = generateTraceId();
    assert.throws(
      () => corr.assert({ traceId, idempotencyKey: traceId }),
      CorrelationDistinctViolation,
    );
  });

  it('idempotencyKey 空串抛 CorrelationDistinctViolation', () => {
    assert.throws(
      () => corr.assert({ traceId: generateTraceId(), idempotencyKey: '' }),
      CorrelationDistinctViolation,
    );
  });

  it('非法 traceId 抛 TypeError', () => {
    assert.throws(() => corr.assert({ traceId: 'not-a-trace' }), TypeError);
  });

  it('isTraceIdLike / isIdempotencyKeyLike 分流', () => {
    const traceId = generateTraceId();
    assert.equal(corr.isTraceIdLike(traceId), true);
    assert.equal(corr.isTraceIdLike('xx_' + 'a'.repeat(36)), false);
    assert.equal(corr.isIdempotencyKeyLike('recruitment:abc123'), true);
    assert.equal(corr.isIdempotencyKeyLike(traceId), false);
    assert.equal(corr.isIdempotencyKeyLike(''), false);
    assert.equal(corr.isIdempotencyKeyLike(null), false);
  });
});