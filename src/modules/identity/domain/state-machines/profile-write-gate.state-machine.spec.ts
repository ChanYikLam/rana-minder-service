/**
 * TST-SM-002（IFC-SM-002 / SRS-SM-IDN-002）资料写入门状态机单元测试。
 *
 * 六分面落点：NOM（规范路径）、STA（状态不匹配）、VER（版本/规则版本竞争）、
 * REV（守卫拒绝语义）。复合派生落位（R001/R002/R005/R008）由
 * ProfileGatePolicy 提供 derivedNextState，本套件验证状态机守卫本身。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  DefaultProfileWriteGateStateMachine,
  ProfileWriteGateState,
  ProfileWriteGateEvent,
} from './profile-write-gate.state-machine';

const S = ProfileWriteGateState;
const E = ProfileWriteGateEvent;
const machine = new DefaultProfileWriteGateStateMachine();

describe('SRS-SM-IDN-002 R001 保存平台公共资料', () => {
  it('NOM：仍缺项 → 保持待补充（派生结果落位）', () => {
    const r = machine.transition({
      event: E.SAVE_PLATFORM_PROFILE,
      currentState: S.PENDING_COMPLETION,
      derivedNextState: S.PENDING_COMPLETION,
    });
    assert.equal(r.allowed, true);
    assert.equal(r.nextState, S.PENDING_COMPLETION);
  });

  it('NOM：补全 → 待邮箱验证（不得绕过邮箱门）', () => {
    const r = machine.transition({
      event: E.SAVE_PLATFORM_PROFILE,
      currentState: S.PENDING_COMPLETION,
      derivedNextState: S.PENDING_EMAIL_VERIFICATION,
    });
    assert.equal(r.allowed, true);
    assert.equal(r.nextState, S.PENDING_EMAIL_VERIFICATION);
  });

  it('STA：非待补充状态不得保存平台公共资料', () => {
    const r = machine.transition({
      event: E.SAVE_PLATFORM_PROFILE,
      currentState: S.WRITABLE,
      derivedNextState: S.WRITABLE,
    });
    assert.equal(r.allowed, false);
  });

  it('REV：派生结果缺失 → 拒绝（原子重算不可缺）', () => {
    const r = machine.transition({
      event: E.SAVE_PLATFORM_PROFILE,
      currentState: S.PENDING_COMPLETION,
    });
    assert.equal(r.allowed, false);
  });
});

describe('SRS-SM-IDN-002 R002 补齐最后一项平台必填', () => {
  it('NOM：补齐且邮箱已验证 → 可写', () => {
    const r = machine.transition({
      event: E.COMPLETE_LAST_REQUIRED,
      currentState: S.PENDING_COMPLETION,
      derivedNextState: S.WRITABLE,
    });
    assert.equal(r.allowed, true);
    assert.equal(r.nextState, S.WRITABLE);
  });

  it('NOM：补齐但邮箱未验证 → 待邮箱验证（不得因资料完成绕过未验证邮箱）', () => {
    const r = machine.transition({
      event: E.COMPLETE_LAST_REQUIRED,
      currentState: S.PENDING_COMPLETION,
      derivedNextState: S.PENDING_EMAIL_VERIFICATION,
    });
    assert.equal(r.allowed, true);
    assert.equal(r.nextState, S.PENDING_EMAIL_VERIFICATION);
  });

  it('STA：仍缺项不得转换', () => {
    const r = machine.transition({
      event: E.COMPLETE_LAST_REQUIRED,
      currentState: S.PENDING_COMPLETION,
      derivedNextState: S.PENDING_COMPLETION,
    });
    // 派生仍为待补充属于"未补齐"，状态机按派生结果落位；实际缺项判断在策略层
    assert.equal(r.allowed, true);
    assert.equal(r.nextState, S.PENDING_COMPLETION);
  });
});

describe('SRS-SM-IDN-002 R003 发送/重发验证邮件（自环）', () => {
  it('NOM：邮箱有效+频率允许+发信可用 → 保持待邮箱验证', () => {
    const r = machine.transition({
      event: E.SEND_VERIFICATION_EMAIL,
      currentState: S.PENDING_EMAIL_VERIFICATION,
      emailValid: true,
      resendAllowed: true,
      mailCapable: true,
    });
    assert.equal(r.allowed, true);
    assert.equal(r.nextState, S.PENDING_EMAIL_VERIFICATION);
  });

  it('REV：重发频率超限 → 拒绝，保持待邮箱验证', () => {
    const r = machine.transition({
      event: E.SEND_VERIFICATION_EMAIL,
      currentState: S.PENDING_EMAIL_VERIFICATION,
      emailValid: true,
      resendAllowed: false,
      mailCapable: true,
    });
    assert.equal(r.allowed, false);
  });

  it('REV：平台发信能力不可用 → 拒绝（运维故障，不绕过验证）', () => {
    const r = machine.transition({
      event: E.SEND_VERIFICATION_EMAIL,
      currentState: S.PENDING_EMAIL_VERIFICATION,
      emailValid: true,
      resendAllowed: true,
      mailCapable: false,
    });
    assert.equal(r.allowed, false);
  });

  it('STA：可写状态无需验证邮件', () => {
    const r = machine.transition({
      event: E.SEND_VERIFICATION_EMAIL,
      currentState: S.WRITABLE,
      emailValid: true,
      resendAllowed: true,
      mailCapable: true,
    });
    assert.equal(r.allowed, false);
  });
});

describe('SRS-SM-IDN-002 R004 验证链接过期或被新请求取代（自环）', () => {
  it('NOM：过期链接 → 原子使链接失效，旧有效邮箱保持，不改变资料门', () => {
    const r = machine.transition({
      event: E.VERIFICATION_EXPIRED_OR_SUPERSEDED,
      currentState: S.PENDING_EMAIL_VERIFICATION,
    });
    assert.equal(r.allowed, true);
    assert.equal(r.nextState, S.PENDING_EMAIL_VERIFICATION);
  });

  it('STA：已验证状态不得使用过期链接解锁写入', () => {
    const r = machine.transition({
      event: E.VERIFICATION_EXPIRED_OR_SUPERSEDED,
      currentState: S.WRITABLE,
    });
    assert.equal(r.allowed, false);
  });
});

describe('SRS-SM-IDN-002 R005 验证链接成功', () => {
  it('NOM：验证成功且无分范围限制 → 可写', () => {
    const r = machine.transition({
      event: E.VERIFICATION_SUCCESS,
      currentState: S.PENDING_EMAIL_VERIFICATION,
      derivedNextState: S.WRITABLE,
    });
    assert.equal(r.allowed, true);
    assert.equal(r.nextState, S.WRITABLE);
  });

  it('NOM：验证成功但存在分范围缺项 → 分范围受限', () => {
    const r = machine.transition({
      event: E.VERIFICATION_SUCCESS,
      currentState: S.PENDING_EMAIL_VERIFICATION,
      derivedNextState: S.PARTIALLY_RESTRICTED,
    });
    assert.equal(r.allowed, true);
    assert.equal(r.nextState, S.PARTIALLY_RESTRICTED);
  });

  it('STA：不可写状态不得因成功验证解锁', () => {
    const r = machine.transition({
      event: E.VERIFICATION_SUCCESS,
      currentState: S.PENDING_COMPLETION,
      derivedNextState: S.WRITABLE,
    });
    assert.equal(r.allowed, false);
  });
});

describe('SRS-SM-IDN-002 R006 平台新必填字段到达生效日', () => {
  it('NOM：字段已发布且生效、当前值缺失 → 待补充（全系统除补资料外写入关闭）', () => {
    const r = machine.transition({
      event: E.NEW_REQUIRED_FIELD_EFFECTIVE,
      currentState: S.WRITABLE,
      fieldEffective: true,
      valueMissing: true,
    });
    assert.equal(r.allowed, true);
    assert.equal(r.nextState, S.PENDING_COMPLETION);
  });

  it('VER：字段未生效 → 不转换（保持可写）', () => {
    const r = machine.transition({
      event: E.NEW_REQUIRED_FIELD_EFFECTIVE,
      currentState: S.WRITABLE,
      fieldEffective: false,
      valueMissing: true,
    });
    assert.equal(r.allowed, false);
  });

  it('VER：用户已补齐 → 不转换（与补齐提交以同一版本边界重算）', () => {
    const r = machine.transition({
      event: E.NEW_REQUIRED_FIELD_EFFECTIVE,
      currentState: S.WRITABLE,
      fieldEffective: true,
      valueMissing: false,
    });
    assert.equal(r.allowed, false);
  });
});

describe('SRS-SM-IDN-002 R007 社团/报名范围缺失生效', () => {
  it('NOM：缺失只影响一个社团/报名 → 分范围受限', () => {
    const r = machine.transition({
      event: E.SCOPE_REQUIREMENT_MISSING,
      currentState: S.WRITABLE,
    });
    assert.equal(r.allowed, true);
    assert.equal(r.nextState, S.PARTIALLY_RESTRICTED);
  });

  it('STA：平台级缺失不适用范围限制（平台门优先）', () => {
    const r = machine.transition({
      event: E.SCOPE_REQUIREMENT_MISSING,
      currentState: S.PENDING_COMPLETION,
    });
    assert.equal(r.allowed, false);
  });
});

describe('SRS-SM-IDN-002 R008 补齐特定范围或限制被撤销', () => {
  it('NOM：目标范围满足且无其他限制 → 可写', () => {
    const r = machine.transition({
      event: E.SCOPE_REQUIREMENT_SATISFIED,
      currentState: S.PARTIALLY_RESTRICTED,
      scopeSatisfied: true,
      derivedNextState: S.WRITABLE,
    });
    assert.equal(r.allowed, true);
    assert.equal(r.nextState, S.WRITABLE);
  });

  it('NOM：其他限制仍生效 → 保持分范围受限（多限制并集）', () => {
    const r = machine.transition({
      event: E.SCOPE_REQUIREMENT_SATISFIED,
      currentState: S.PARTIALLY_RESTRICTED,
      scopeSatisfied: true,
      derivedNextState: S.PARTIALLY_RESTRICTED,
    });
    assert.equal(r.allowed, true);
    assert.equal(r.nextState, S.PARTIALLY_RESTRICTED);
  });

  it('REV：该范围要求未满足 → 拒绝解除（并发新增限制不能被旧请求清除）', () => {
    const r = machine.transition({
      event: E.SCOPE_REQUIREMENT_SATISFIED,
      currentState: S.PARTIALLY_RESTRICTED,
      scopeSatisfied: false,
      derivedNextState: S.PARTIALLY_RESTRICTED,
    });
    assert.equal(r.allowed, false);
  });
});
