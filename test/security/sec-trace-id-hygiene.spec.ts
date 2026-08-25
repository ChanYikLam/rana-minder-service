/**
 * 安全控制独立验证：SEC-CTL-034（唯一安全追踪编号与父子关系）。
 *
 * 权威来源：docs/specification/安全设计与实现级威胁模型-v1.0.md §5；
 * NFR-006、SRS-NFR-026、XCC-GEN-001。
 *
 * 验证路径（真实代码，无 pg/jose 依赖）：
 * - src/platform/observability/domain/services/trace-id.generator.ts
 * - src/platform/tasks/idempotency/idempotency-key.ts（追踪编号不替代幂等键）
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  TRACE_PREFIX,
  deriveTrace,
  generateTraceId,
  isTraceId,
} from '../../src/platform/observability/domain/services/trace-id.generator';
import { assertIdempotencyKeyDistinctFromTrackingNumber } from '../../src/platform/tasks/idempotency/idempotency-key';

describe('SEC-CTL-034 追踪编号唯一性与格式卫生', () => {
  it('SEC-CTL-034：批量生成全部唯一且符合 tr_+UUID 形状', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i += 1) {
      const id = generateTraceId();
      assert.ok(isTraceId(id), id);
      assert.ok(id.startsWith(TRACE_PREFIX));
      assert.equal(id.length, TRACE_PREFIX.length + 36);
      // 不编码用户可控输入：主体标识不出现在编号中
      assert.ok(!id.includes('user'));
      seen.add(id);
    }
    assert.equal(seen.size, 200);
  });

  it('SEC-CTL-034：isTraceId 对伪造形状拒绝（缺前缀/错长/连字符错位）', () => {
    assert.equal(isTraceId('not-a-trace'), false);
    assert.equal(isTraceId('tr_short'), false);
    assert.equal(isTraceId(`tr_${'a'.repeat(36)}`), false, '长度相同但无分段连字符');
    assert.equal(isTraceId(null), false);
    assert.equal(isTraceId(42), false);
  });

  it('SEC-CTL-034：父子派生关系只承载合法编号；非法输入显式 TypeError', () => {
    const parent = generateTraceId();
    const child = generateTraceId();
    assert.deepEqual(deriveTrace(child, parent), { childTraceId: child, parentTraceId: parent });
    const orphan = deriveTrace(child);
    assert.equal(orphan.childTraceId, child);
    assert.equal(orphan.parentTraceId, undefined);

    assert.throws(() => deriveTrace('bogus-id', parent), TypeError);
    assert.throws(() => deriveTrace(child, 'bogus-parent'), TypeError);
  });

  it('SEC-CTL-034：追踪编号不得替代业务幂等键（混同即抛错）', () => {
    const trace = generateTraceId();
    assert.throws(() => assertIdempotencyKeyDistinctFromTrackingNumber(trace, trace));
    assert.doesNotThrow(() =>
      assertIdempotencyKeyDistinctFromTrackingNumber('biz-idem-key', trace),
    );
  });
});
