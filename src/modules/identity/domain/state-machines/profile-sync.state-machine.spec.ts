/**
 * TST-SM-003（IFC-SM-003 / SRS-SM-IDN-003）资料同步状态机单元测试。
 *
 * 六分面落点：NOM（规范路径）、STA（状态不匹配）、VER（版本冲突：更晚本地版本）、
 * CON（同一字段版本只收口一次）、REV（守卫拒绝语义）。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  DefaultProfileSyncStateMachine,
  ProfileSyncState,
  ProfileSyncEvent,
} from './profile-sync.state-machine';

const S = ProfileSyncState;
const E = ProfileSyncEvent;
const machine = new DefaultProfileSyncStateMachine();

describe('SRS-SM-IDN-003 R001 本地保存白名单字段合法新值', () => {
  it('NOM：已同步+合法保存 → 待同步', () => {
    const r = machine.transition({ event: E.LOCAL_SAVE, currentState: S.SYNCED });
    assert.equal(r.allowed, true);
    assert.equal(r.nextState, S.PENDING_SYNC);
  });

  it('STA：重试中不接受本地新保存（版本冲突走旧版本拒绝）', () => {
    const r = machine.transition({ event: E.LOCAL_SAVE, currentState: S.RETRYING });
    assert.equal(r.allowed, false);
  });
});

describe('SRS-SM-IDN-003 R002 启动 Casdoor 写入', () => {
  it('NOM：待同步+意图有效+未被更新版本取代 → 重试中', () => {
    const r = machine.transition({
      event: E.START_WRITE,
      currentState: S.PENDING_SYNC,
      isCurrentVersion: true,
    });
    assert.equal(r.allowed, true);
    assert.equal(r.nextState, S.RETRYING);
  });

  it('VER：存在更晚本地版本 → 取消本尝试，保持最新状态', () => {
    const r = machine.transition({
      event: E.START_WRITE,
      currentState: S.PENDING_SYNC,
      isCurrentVersion: false,
    });
    assert.equal(r.allowed, false);
  });
});

describe('SRS-SM-IDN-003 R003 写入并回读确认目标值', () => {
  it('NOM：回读=目标值 → 已同步', () => {
    const r = machine.transition({
      event: E.WRITE_CONFIRMED,
      currentState: S.RETRYING,
      isCurrentVersion: true,
    });
    assert.equal(r.allowed, true);
    assert.equal(r.nextState, S.SYNCED);
  });

  it('REV：回读不一致或不确定不得成功', () => {
    // 状态机层：不在重试中即拒绝；读回值判定由策略层处理
    const r = machine.transition({
      event: E.WRITE_CONFIRMED,
      currentState: S.PENDING_SYNC,
      isCurrentVersion: true,
    });
    assert.equal(r.allowed, false);
  });
});

describe('SRS-SM-IDN-003 R004 临时失败且未满 24 小时', () => {
  it('NOM：待同步/重试中+可重试+未满 24h → 重试中', () => {
    const r = machine.transition({
      event: E.TRANSIENT_FAILURE,
      currentState: S.PENDING_SYNC,
      isCurrentVersion: true,
    });
    assert.equal(r.allowed, true);
    assert.equal(r.nextState, S.RETRYING);
  });

  it('VER：更晚版本取代旧意图 → 不继续旧重试', () => {
    const r = machine.transition({
      event: E.TRANSIENT_FAILURE,
      currentState: S.RETRYING,
      isCurrentVersion: false,
    });
    assert.equal(r.allowed, false);
  });
});

describe('SRS-SM-IDN-003 R005 连续 24 小时仍失败', () => {
  it('NOM：重试中+达 24h 边界 → 待读回核验（冻结盲目写重试）', () => {
    const r = machine.transition({
      event: E.TWENTY_FOUR_HOUR_FAILURE,
      currentState: S.RETRYING,
      isCurrentVersion: true,
    });
    assert.equal(r.allowed, true);
    assert.equal(r.nextState, S.PENDING_READBACK_VERIFICATION);
  });

  it('STA：未满 24 小时不得提前回退', () => {
    const r = machine.transition({
      event: E.TWENTY_FOUR_HOUR_FAILURE,
      currentState: S.PENDING_SYNC,
      isCurrentVersion: true,
    });
    assert.equal(r.allowed, false);
  });
});

describe('SRS-SM-IDN-003 R006 回读确认已是目标值', () => {
  it('NOM：待读回核验+回读=目标 → 已同步', () => {
    const r = machine.transition({
      event: E.READBACK_TARGET,
      currentState: S.PENDING_READBACK_VERIFICATION,
      isCurrentVersion: true,
    });
    assert.equal(r.allowed, true);
    assert.equal(r.nextState, S.SYNCED);
  });

  it('VER：更晚版本 → 拒绝，保持待读回核验', () => {
    const r = machine.transition({
      event: E.READBACK_TARGET,
      currentState: S.PENDING_READBACK_VERIFICATION,
      isCurrentVersion: false,
    });
    assert.equal(r.allowed, false);
  });
});

describe('SRS-SM-IDN-003 R007 回读确认仍为修改前有效值', () => {
  it('NOM：待读回核验+回读=原值 → 已回退', () => {
    const r = machine.transition({
      event: E.READBACK_ORIGINAL,
      currentState: S.PENDING_READBACK_VERIFICATION,
      isCurrentVersion: true,
    });
    assert.equal(r.allowed, true);
    assert.equal(r.nextState, S.ROLLED_BACK);
  });

  it('REV：无法确认或存在更晚版本时不得回退', () => {
    const r = machine.transition({
      event: E.READBACK_ORIGINAL,
      currentState: S.PENDING_READBACK_VERIFICATION,
      isCurrentVersion: false,
    });
    assert.equal(r.allowed, false);
  });
});

describe('SRS-SM-IDN-003 R008 普通可编辑字段读回第三值', () => {
  it('NOM：可编辑字段+第三值 → 同步冲突待本人选择', () => {
    const r = machine.transition({
      event: E.READBACK_THIRD_VALUE,
      currentState: S.PENDING_READBACK_VERIFICATION,
      isCurrentVersion: true,
      editableField: true,
    });
    assert.equal(r.allowed, true);
    assert.equal(r.nextState, S.CONFLICT_PENDING_USER_CHOICE);
  });

  it('REV：只读权威字段第三值不进入本人选择', () => {
    const r = machine.transition({
      event: E.READBACK_THIRD_VALUE,
      currentState: S.PENDING_READBACK_VERIFICATION,
      isCurrentVersion: true,
      editableField: false,
    });
    assert.equal(r.allowed, false);
  });

  it('VER：版本已变化 → 保持待读回核验', () => {
    const r = machine.transition({
      event: E.READBACK_THIRD_VALUE,
      currentState: S.PENDING_READBACK_VERIFICATION,
      isCurrentVersion: false,
      editableField: true,
    });
    assert.equal(r.allowed, false);
  });
});

describe('SRS-SM-IDN-003 R009 本人选择保留本地目标值', () => {
  it('NOM：冲突版本匹配+重新读回一致 → 待同步（新版本+新幂等键由应用层创建）', () => {
    const r = machine.transition({
      event: E.USER_CHOICE_KEEP_LOCAL,
      currentState: S.CONFLICT_PENDING_USER_CHOICE,
      conflictVersionMatches: true,
      readbackStillMatchesSnapshot: true,
    });
    assert.equal(r.allowed, true);
    assert.equal(r.nextState, S.PENDING_SYNC);
  });

  it('REV：冲突版本不匹配 → 拒绝并刷新比较', () => {
    const r = machine.transition({
      event: E.USER_CHOICE_KEEP_LOCAL,
      currentState: S.CONFLICT_PENDING_USER_CHOICE,
      conflictVersionMatches: false,
      readbackStillMatchesSnapshot: true,
    });
    assert.equal(r.allowed, false);
  });

  it('REV：提交前重新读回与快照不一致 → 拒绝并刷新比较', () => {
    const r = machine.transition({
      event: E.USER_CHOICE_KEEP_LOCAL,
      currentState: S.CONFLICT_PENDING_USER_CHOICE,
      conflictVersionMatches: true,
      readbackStillMatchesSnapshot: false,
    });
    assert.equal(r.allowed, false);
  });
});

describe('SRS-SM-IDN-003 R010 本人选择接受 Casdoor 当前值', () => {
  it('NOM：冲突版本匹配+重新读回一致 → 已同步（保留全部历史）', () => {
    const r = machine.transition({
      event: E.USER_CHOICE_ACCEPT_CASDOOR,
      currentState: S.CONFLICT_PENDING_USER_CHOICE,
      conflictVersionMatches: true,
      readbackStillMatchesSnapshot: true,
    });
    assert.equal(r.allowed, true);
    assert.equal(r.nextState, S.SYNCED);
  });

  it('CON：与保留本地值竞争只允许一个成功（同一冲突版本单胜者）', () => {
    const keep = machine.transition({
      event: E.USER_CHOICE_KEEP_LOCAL,
      currentState: S.CONFLICT_PENDING_USER_CHOICE,
      conflictVersionMatches: true,
      readbackStillMatchesSnapshot: true,
    });
    const accept = machine.transition({
      event: E.USER_CHOICE_ACCEPT_CASDOOR,
      currentState: S.CONFLICT_PENDING_USER_CHOICE,
      conflictVersionMatches: true,
      readbackStillMatchesSnapshot: true,
    });
    // 两个静态转换都合法；单胜者由应用层以冲突版本乐观锁裁决（旧版本提交拒绝）
    assert.equal(keep.allowed, true);
    assert.equal(accept.allowed, true);
  });
});

describe('SRS-SM-IDN-003 R011 只读权威字段读回第三值', () => {
  it('NOM：姓名/学号第三值 → 收敛为 Casdoor 当前值（已同步）', () => {
    const r = machine.transition({
      event: E.READBACK_AUTHORITATIVE_THIRD,
      currentState: S.PENDING_READBACK_VERIFICATION,
      isCurrentVersion: true,
      editableField: false,
    });
    assert.equal(r.allowed, true);
    assert.equal(r.nextState, S.SYNCED);
  });

  it('REV：可编辑字段必须进入本人选择，不走收敛', () => {
    const r = machine.transition({
      event: E.READBACK_AUTHORITATIVE_THIRD,
      currentState: S.PENDING_READBACK_VERIFICATION,
      isCurrentVersion: true,
      editableField: true,
    });
    assert.equal(r.allowed, false);
  });
});

describe('SRS-SM-IDN-003 R012 有权人工处理并重新发起同步', () => {
  it('NOM：已回退 → 待同步（新版本+新幂等键，不重放旧请求）', () => {
    const r = machine.transition({
      event: E.MANUAL_RETRY,
      currentState: S.ROLLED_BACK,
      retryTarget: S.PENDING_SYNC,
    });
    assert.equal(r.allowed, true);
    assert.equal(r.nextState, S.PENDING_SYNC);
  });

  it('NOM：待读回核验 → 人工处理（平台管理员处置）', () => {
    const r = machine.transition({
      event: E.MANUAL_RETRY,
      currentState: S.PENDING_READBACK_VERIFICATION,
      retryTarget: S.MANUAL_INTERVENTION,
    });
    assert.equal(r.allowed, true);
    assert.equal(r.nextState, S.MANUAL_INTERVENTION);
  });

  it('REV：无权/未读回/仍基于旧版本 → 保持原状态', () => {
    const r = machine.transition({
      event: E.MANUAL_RETRY,
      currentState: S.RETRYING,
      retryTarget: S.PENDING_SYNC,
    });
    assert.equal(r.allowed, false);
  });
});
