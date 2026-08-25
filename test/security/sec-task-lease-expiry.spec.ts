/**
 * 安全控制独立验证：SEC-CTL-012（后台任务租约/冻结意图边界）。
 *
 * 权威来源：docs/specification/安全设计与实现级威胁模型-v1.0.md §5、§8.4；
 * SEC-VER-011（旧租约、过期迟到提交、版本变化均不能提交业务结果）。
 *
 * 验证路径（真实纯函数，无 pg/jose 依赖）：
 * - src/platform/tasks/lease/lease.ts
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  assertLeaseVersion,
  computeLeaseUntil,
  decideLease,
  isLeaseExpired,
  isLeaseValid,
  nextLeaseVersion,
} from '../../src/platform/tasks/lease/lease';
import type { TaskLease } from '../../src/platform/tasks/contracts';

const NOW = new Date('2026-08-24T10:00:00Z');

function lease(leaseVersion: number, leaseUntil: string): TaskLease {
  return { leaseVersion, leaseUntil, workerId: 'worker-A' } as unknown as TaskLease;
}

describe('SEC-CTL-012 任务租约互斥与旧租约提交拒绝', () => {
  it('SEC-CTL-012：无租约首次领取为 ACQUIRED；有效租约期内第二 worker 为 BUSY（单胜者）', () => {
    assert.equal(decideLease(null, NOW), 'ACQUIRED');
    const active = lease(1, computeLeaseUntil(NOW, 60_000));
    assert.equal(isLeaseValid(active, NOW), true);
    assert.equal(decideLease(active, new Date(NOW.getTime() + 1000)), 'BUSY');
  });

  it('SEC-CTL-012：租约过期后判定 EXPIRED_RECOVERED，允许新租约且版本单调递增', () => {
    const expired = lease(3, computeLeaseUntil(NOW, -1));
    assert.equal(isLeaseExpired(expired, NOW), true);
    assert.equal(decideLease(expired, NOW), 'EXPIRED_RECOVERED');
    assert.equal(nextLeaseVersion(3), 4);
    assert.equal(nextLeaseVersion(null), 1);
  });

  it('SEC-CTL-012：迟到提交按租约版本校验——旧 worker 版本不匹配必须失败', () => {
    const current = lease(5, computeLeaseUntil(NOW, 60_000));
    assert.equal(assertLeaseVersion(current, 5), true, '当前租约持有者可提交');
    assert.equal(
      assertLeaseVersion(current, 4),
      false,
      '被取代的旧租约（版本落后）不得覆盖新结果',
    );
    assert.equal(assertLeaseVersion(null, 0), false, '无租约不得提交');
  });

  it('SEC-CTL-012：computeLeaseUntil 产出未来 ISO 时刻，作为冻结意图的到期证据', () => {
    const until = computeLeaseUntil(NOW, 30_000);
    assert.equal(new Date(until).getTime(), NOW.getTime() + 30_000);
    assert.match(until, /^\d{4}-\d{2}-\d{2}T/);
  });
});
