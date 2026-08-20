/**
 * ProfileGatePolicy（IDN-002 复合派生门）单元测试。
 *
 * 覆盖：派生优先级（平台必填 > 邮箱验证 > 分范围限制）、多限制并集、单独解除、
 * 作用域键唯一（IDN-019、FORM-011）。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DefaultProfileGatePolicy } from './profile-gate.policy';

const policy = new DefaultProfileGatePolicy();
const now = new Date('2026-08-20T00:00:00.000Z');
const restriction = (scopeKey: string) => ({ scopeKey, reason: '资料缺失', since: now });

describe('IDN-002 派生优先级（平台必填 > 邮箱验证 > 分范围限制）', () => {
  it('平台必填缺失 → 待补充（全系统除补资料外写入关闭）', () => {
    const gate = policy.deriveGate({
      platformMissingFields: ['grade'],
      emailVerified: true,
      restrictions: [],
    });
    assert.equal(gate, 'PENDING_COMPLETION');
  });

  it('平台必填完备但邮箱未验证 → 待邮箱验证', () => {
    const gate = policy.deriveGate({
      platformMissingFields: [],
      emailVerified: false,
      restrictions: [],
    });
    assert.equal(gate, 'PENDING_EMAIL_VERIFICATION');
  });

  it('平台完备+邮箱已验证+存在限制 → 分范围受限', () => {
    const gate = policy.deriveGate({
      platformMissingFields: [],
      emailVerified: true,
      restrictions: [restriction('club-1')],
    });
    assert.equal(gate, 'PARTIALLY_RESTRICTED');
  });

  it('全部满足 → 可写', () => {
    const gate = policy.deriveGate({
      platformMissingFields: [],
      emailVerified: true,
      restrictions: [],
    });
    assert.equal(gate, 'WRITABLE');
  });

  it('平台缺失时即使邮箱未验证也以平台门为准（优先级）', () => {
    const gate = policy.deriveGate({
      platformMissingFields: ['phone'],
      emailVerified: false,
      restrictions: [restriction('club-2')],
    });
    assert.equal(gate, 'PENDING_COMPLETION');
  });
});

describe('IDN-019 分范围限制：作用域键唯一 + 多限制并集', () => {
  it('isScopeRestricted：按作用域键判定', () => {
    assert.equal(policy.isScopeRestricted([restriction('club-1')], 'club-1'), true);
    assert.equal(policy.isScopeRestricted([restriction('club-1')], 'club-2'), false);
  });

  it('remainingRestrictions：解除一个不影响其他限制', () => {
    const rest = [restriction('club-1'), restriction('club-2'), restriction('application-9')];
    const remaining = policy.remainingRestrictions(rest, 'club-1');
    assert.equal(remaining.length, 2);
    assert.deepEqual(remaining.map((r) => r.scopeKey).sort(), ['application-9', 'club-2']);
  });

  it('解除不存在的限制返回原集合（无副作用）', () => {
    const rest = [restriction('club-1')];
    assert.equal(policy.remainingRestrictions(rest, 'nope').length, 1);
  });
});
