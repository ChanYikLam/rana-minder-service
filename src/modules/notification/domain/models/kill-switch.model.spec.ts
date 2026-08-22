/**
 * 站内信紧急关闭领域模型测试（SRS-FAIL-009、IFC-NTF-001、XCC-FAIL-009）。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { validateKillSwitchCommandInput } from './kill-switch.model';
import {
  resolveEffectiveDeadlineStatus,
  validatePresentationStatusTransition,
} from './inbox-presentation.model';

describe('KillSwitch 模型（SRS-FAIL-009）', () => {
  const base = {
    scope: 'CLUB' as const,
    clubId: 'club-1',
    reason: '平台维护',
    operatorId: 'admin-1',
    operatorName: '超管甲',
    expectedRecoveryAt: '2026-09-01T00:00:00.000Z',
    confirmed: true,
  };

  it('合法输入通过校验', () => {
    assert.equal(validateKillSwitchCommandInput(base), null);
  });

  it('缺少原因 → 拒绝（必须填写原因）', () => {
    const error = validateKillSwitchCommandInput({ ...base, reason: '  ' });
    assert.ok(error?.includes('原因'));
  });

  it('未二次确认 → 拒绝（必须二次确认）', () => {
    const error = validateKillSwitchCommandInput({ ...base, confirmed: false });
    assert.ok(error?.includes('二次确认'));
  });

  it('缺少预计恢复时间 → 拒绝（必须设置预计恢复时间）', () => {
    const error = validateKillSwitchCommandInput({ ...base, expectedRecoveryAt: null });
    assert.ok(error?.includes('预计恢复时间'));
  });

  it('社团范围缺少社团标识 → 拒绝', () => {
    const error = validateKillSwitchCommandInput({ ...base, clubId: null });
    assert.ok(error?.includes('社团标识'));
  });

  it('平台范围携带社团标识 → 拒绝', () => {
    const error = validateKillSwitchCommandInput({ ...base, scope: 'PLATFORM', clubId: 'club-1' });
    assert.ok(error?.includes('社团标识'));
  });

  it('预计恢复时间为非法时间 → 拒绝', () => {
    const error = validateKillSwitchCommandInput({
      ...base,
      expectedRecoveryAt: 'not-a-date',
    });
    assert.ok(error?.includes('合法时间'));
  });
});

describe('有期限通知当前办理状态推导（NTF-003）', () => {
  const now = '2026-09-10T00:00:00.000Z';
  const past = '2026-09-01T00:00:00.000Z';
  const future = '2026-09-20T00:00:00.000Z';

  it('未过期且无存储状态 → 可处理 ACTIONABLE', () => {
    assert.equal(resolveEffectiveDeadlineStatus(null, future, now), 'ACTIONABLE');
  });

  it('超过截止时间 → 已过期 EXPIRED', () => {
    assert.equal(resolveEffectiveDeadlineStatus(null, past, now), 'EXPIRED');
  });

  it('已处理为终态，过期后仍保持已处理', () => {
    assert.equal(resolveEffectiveDeadlineStatus('PROCESSED', past, now), 'PROCESSED');
  });

  it('已撤回为终态，过期后仍保持已撤回', () => {
    assert.equal(resolveEffectiveDeadlineStatus('WITHDRAWN', past, now), 'WITHDRAWN');
  });

  it('无期限通知保留存储状态', () => {
    assert.equal(resolveEffectiveDeadlineStatus('ACTIONABLE', null, now), 'ACTIONABLE');
    assert.equal(resolveEffectiveDeadlineStatus(null, null, now), null);
  });
});

describe('呈现子状态转换校验（NTF-003）', () => {
  it('已处理不可逆回未读', () => {
    assert.ok(validatePresentationStatusTransition('PROCESSED', 'UNREAD')?.includes('不可逆回'));
  });

  it('已隐藏不可逆回已读', () => {
    assert.ok(validatePresentationStatusTransition('HIDDEN', 'READ')?.includes('不可逆回'));
  });

  it('未读 → 已读/已处理/已隐藏 均合法', () => {
    assert.equal(validatePresentationStatusTransition('UNREAD', 'READ'), null);
    assert.equal(validatePresentationStatusTransition('UNREAD', 'PROCESSED'), null);
    assert.equal(validatePresentationStatusTransition('UNREAD', 'HIDDEN'), null);
  });
});
