/**
 * 安全控制独立验证：SEC-CTL-022（幂等键绑定与防重放歧义）。
 *
 * 权威来源：docs/specification/安全设计与实现级威胁模型-v1.0.md §5、§13。
 *
 * 验证路径（真实代码，无 pg/jose 依赖）：
 * - src/platform/tasks/idempotency/idempotency-key.ts
 * - src/platform/tasks/idempotency/in-memory-idempotency-store.ts（同键并发单意图）
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  assertIdempotencyKeyDistinctFromTrackingNumber,
  deriveIdempotencyKey,
  isValidIdempotencyKey,
} from '../../src/platform/tasks/idempotency/idempotency-key';
import { InMemoryIdempotencyStore } from '../../src/platform/tasks/idempotency/in-memory-idempotency-store';
import type { TaskSourceRef } from '../../src/platform/tasks/contracts';

const source: TaskSourceRef = {
  scope: { kind: 'CLUB', clubId: 'c1' },
  objectType: 'INVITATION',
  objectId: 'obj-1',
  version: 3,
} as unknown as TaskSourceRef;

describe('SEC-CTL-022 幂等键绑定主体、作用域与参数摘要', () => {
  it('SEC-CTL-022：同参数派生稳定键；版本或作用域变化即不同键（同键异参可判别）', () => {
    const base = deriveIdempotencyKey('MEMBER_IMPORT', source);
    assert.equal(base, deriveIdempotencyKey('MEMBER_IMPORT', source));

    const versionBumped = deriveIdempotencyKey('MEMBER_IMPORT', source, 4);
    assert.notEqual(base, versionBumped, '对象版本必须进入幂等键摘要');

    const otherScope = deriveIdempotencyKey('MEMBER_IMPORT', {
      ...source,
      scope: { kind: 'CLUB', clubId: 'c2' },
    } as TaskSourceRef);
    assert.notEqual(base, otherScope, '跨社团复用同一键必须不可行');

    const otherObject = deriveIdempotencyKey('MEMBER_IMPORT', {
      ...source,
      objectId: 'obj-2',
    } as TaskSourceRef);
    assert.notEqual(base, otherObject);
  });

  it('SEC-CTL-022：追踪编号与幂等键混同被显式拒绝（XCC-GEN-001）', () => {
    assert.throws(() => assertIdempotencyKeyDistinctFromTrackingNumber('same', 'same'));
    assert.doesNotThrow(() =>
      assertIdempotencyKeyDistinctFromTrackingNumber('idem-x', 'tr-00000000-0000-0000-0000-000000000000'),
    );
  });

  it('SEC-CTL-022：空键与超长键不合法；平台作用域回退为 platform 段', () => {
    assert.equal(isValidIdempotencyKey(''), false);
    assert.equal(isValidIdempotencyKey('x'.repeat(513)), false);
    assert.equal(isValidIdempotencyKey(deriveIdempotencyKey('OP', { ...source, scope: { kind: 'PLATFORM' } } as TaskSourceRef)), true);
    const platformKey = deriveIdempotencyKey('OP', {
      ...source,
      scope: { kind: 'PLATFORM' },
    } as TaskSourceRef);
    assert.match(platformKey, /^OP:platform:/);
  });
});

describe('SEC-CTL-022 同一意图仅一份有效结果（存储语义）', () => {
  it('SEC-CTL-022：同键并发 begin 单胜者；完成结果只认登记的 resultRef', async () => {
    const store = new InMemoryIdempotencyStore();
    const first = await store.begin('key-1', 'intent-A', '2026-08-24T10:05:00Z');
    const second = await store.begin('key-1', 'intent-B', '2026-08-24T10:06:00Z');
    assert.equal(first, true);
    assert.equal(second, false, '重复领取不得产生第二份执行');

    await store.complete('key-1', 'intent-A', 'result://invite/42');
    const done = await store.find('key-1');
    assert.equal(done?.status, 'COMPLETED');
    assert.equal(done?.resultRef, 'result://invite/42');
    // 迟到的新意图不得复写已完成结果（同意图仅一份有效结果）
    const rejected = await store.begin('key-1', 'intent-C', '2026-08-24T10:07:00Z');
    assert.equal(rejected, false);
    const still = await store.find('key-1');
    assert.equal(still?.status, 'COMPLETED', '已完成结果不得被新 begin 复写');
    assert.equal(still?.resultRef, 'result://invite/42');
  });

  it('SEC-CTL-022：失败记录保留 FAILED 终态供恢复收敛，不伪造成功', async () => {
    const store = new InMemoryIdempotencyStore();
    await store.begin('key-2', 'intent-A', '2026-08-24T10:05:00Z');
    await store.fail('key-2', 'intent-A');
    const failed = await store.find('key-2');
    assert.equal(failed?.status, 'FAILED');
    assert.equal(failed?.resultRef, null);

    const unknown = await store.find('missing-key');
    assert.equal(unknown, null);
  });
});
