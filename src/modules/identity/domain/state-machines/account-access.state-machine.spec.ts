/**
 * TST-SM-001（IFC-SM-001 / SRS-SM-IDN-001）账号访问状态机单元测试。
 *
 * 六分面落点（测试规格 §8）：NOM（规范路径）、STA（状态不匹配）、REV（执行中失权/
 * 拒绝语义）、VER/CON（幂等与单胜者语义）。AUT 分面归属接口层测试（M2）。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  DefaultAccountAccessStateMachine,
  AccountAccessState,
  AccountAccessEvent,
} from './account-access.state-machine';

const S = AccountAccessState;
const E = AccountAccessEvent;
const machine = new DefaultAccountAccessStateMachine();

describe('SRS-SM-IDN-001 R001 有效→禁用（事件/对账确认）', () => {
  it('NOM：有效+可信禁用事件 → 禁用并撤销会话', () => {
    const r = machine.transition({ event: E.CASDOOR_DISABLED, currentState: S.ACTIVE });
    assert.equal(r.allowed, true);
    assert.equal(r.nextState, S.DISABLED);
    assert.equal(r.sessionRevoke, true);
    assert.equal(r.reauthenticationRequired, false);
  });

  it('幂等：重复禁用仅返回既有结果（不产生新状态变化）', () => {
    const r = machine.transition({ event: E.CASDOOR_DISABLED, currentState: S.DISABLED });
    assert.equal(r.allowed, true);
    assert.equal(r.nextState, S.DISABLED);
    assert.equal(r.sessionRevoke, false);
  });

  it('STA：降级中账号收到禁用事件不得直接落禁用（须以回读收口）', () => {
    const r = machine.transition({ event: E.CASDOOR_DISABLED, currentState: S.UNVERIFIABLE });
    assert.equal(r.allowed, false);
    assert.equal(r.nextState, S.UNVERIFIABLE);
  });

  it('STA：已删除账号不得猜测禁用', () => {
    const r = machine.transition({ event: E.CASDOOR_DISABLED, currentState: S.DELETED });
    assert.equal(r.allowed, false);
    assert.equal(r.nextState, S.DELETED);
  });
});

describe('SRS-SM-IDN-001 R002 有效→删除（事件/对账确认）', () => {
  it('NOM：有效+可信删除事件 → 删除并撤销会话', () => {
    const r = machine.transition({ event: E.CASDOOR_DELETED, currentState: S.ACTIVE });
    assert.equal(r.allowed, true);
    assert.equal(r.nextState, S.DELETED);
    assert.equal(r.sessionRevoke, true);
  });

  it('幂等：重复删除仅返回既有结果', () => {
    const r = machine.transition({ event: E.CASDOOR_DELETED, currentState: S.DELETED });
    assert.equal(r.allowed, true);
    assert.equal(r.nextState, S.DELETED);
  });

  it('STA：禁用账号不得猜测删除', () => {
    const r = machine.transition({ event: E.CASDOOR_DELETED, currentState: S.DISABLED });
    assert.equal(r.allowed, false);
    assert.equal(r.nextState, S.DISABLED);
  });
});

describe('SRS-SM-IDN-001 R003 有效→暂不可确认（故障判定）', () => {
  it('NOM：可信故障结果 → 进入降级（记录降级起点）', () => {
    const r = machine.transition({ event: E.CASDOOR_UNVERIFIABLE, currentState: S.ACTIVE });
    assert.equal(r.allowed, true);
    assert.equal(r.nextState, S.UNVERIFIABLE);
  });

  it('STA：已降级账号不重复进入（同一故障窗口合并，应用层按状态版本收口）', () => {
    const r = machine.transition({ event: E.CASDOOR_UNVERIFIABLE, currentState: S.UNVERIFIABLE });
    assert.equal(r.allowed, false);
  });
});

describe('SRS-SM-IDN-001 R004 暂不可确认→回读收口', () => {
  it('NOM：回读=有效 → 结束降级并要求重新认证', () => {
    const r = machine.transition({
      event: E.READBACK_RECOVERED,
      currentState: S.UNVERIFIABLE,
      readbackState: S.ACTIVE,
    });
    assert.equal(r.allowed, true);
    assert.equal(r.nextState, S.ACTIVE);
    assert.equal(r.reauthenticationRequired, true);
  });

  it('NOM：回读=禁用 → 同步终止会话，无 15 分钟宽限', () => {
    const r = machine.transition({
      event: E.READBACK_RECOVERED,
      currentState: S.UNVERIFIABLE,
      readbackState: S.DISABLED,
    });
    assert.equal(r.allowed, true);
    assert.equal(r.nextState, S.DISABLED);
    assert.equal(r.sessionRevoke, true);
  });

  it('REV：回读仍不确定 → 保持降级，不返回假恢复', () => {
    const r = machine.transition({
      event: E.READBACK_RECOVERED,
      currentState: S.UNVERIFIABLE,
      readbackState: S.UNVERIFIABLE,
    });
    assert.equal(r.allowed, false);
    assert.equal(r.nextState, S.UNVERIFIABLE);
  });

  it('STA：非降级状态不得用回读收口', () => {
    const r = machine.transition({
      event: E.READBACK_RECOVERED,
      currentState: S.ACTIVE,
      readbackState: S.ACTIVE,
    });
    assert.equal(r.allowed, false);
  });
});

describe('SRS-SM-IDN-001 R005 禁用→有效（恢复并重新登录）', () => {
  it('NOM：可信恢复 → 有效并要求重新登录', () => {
    const r = machine.transition({ event: E.ACCOUNT_REENABLED, currentState: S.DISABLED });
    assert.equal(r.allowed, true);
    assert.equal(r.nextState, S.ACTIVE);
    assert.equal(r.reauthenticationRequired, true);
  });

  it('STA：账号仍禁用但无法确认 / 已删除 → 保持原状态', () => {
    const r1 = machine.transition({ event: E.ACCOUNT_REENABLED, currentState: S.UNVERIFIABLE });
    assert.equal(r1.allowed, false);
    const r2 = machine.transition({ event: E.ACCOUNT_REENABLED, currentState: S.DELETED });
    assert.equal(r2.allowed, false);
    assert.equal(r2.nextState, S.DELETED);
  });
});

describe('SRS-SM-IDN-001 R006 降级窗口内最小白名单操作（自环）', () => {
  const allowedVerdict = { allowed: true, reason: null };
  const deniedVerdict = { allowed: false, reason: '命令不在白名单' };

  it('NOM：白名单命令判定允许 → 保持暂不可确认且无会话撤销', () => {
    const r = machine.transition({
      event: E.WHITELIST_OPERATION,
      currentState: S.UNVERIFIABLE,
      whitelistVerdict: allowedVerdict,
    });
    assert.equal(r.allowed, true);
    assert.equal(r.nextState, S.UNVERIFIABLE);
    assert.equal(r.sessionRevoke, false);
  });

  it('REV：白名单判定拒绝（超窗/非本人/附件/新建草稿等）→ 拒绝且无副作用', () => {
    const r = machine.transition({
      event: E.WHITELIST_OPERATION,
      currentState: S.UNVERIFIABLE,
      whitelistVerdict: deniedVerdict,
    });
    assert.equal(r.allowed, false);
    assert.equal(r.nextState, S.UNVERIFIABLE);
  });

  it('STA：非降级账号不得执行白名单操作', () => {
    const r = machine.transition({
      event: E.WHITELIST_OPERATION,
      currentState: S.ACTIVE,
      whitelistVerdict: allowedVerdict,
    });
    assert.equal(r.allowed, false);
  });
});
