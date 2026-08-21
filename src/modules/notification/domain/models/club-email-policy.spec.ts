/**
 * 社团邮件策略与用户偏好测试（NTF-004）。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  defaultClubEmailPolicy,
  resolveClubEmailEnabled,
  resolveUserEmailEnabled,
  validateEmailPreferenceUpdate,
  PROTECTED_EMAIL_CATEGORIES,
} from './club-email-policy';

describe('社团邮件策略（NTF-004 默认开启与关闭粒度）', () => {
  it('无策略时默认开启', () => {
    assert.equal(resolveClubEmailEnabled(null, 'conclusion', null), true);
  });

  it('按类型关闭后该类型不发邮件，其他类型不受影响', () => {
    const policy = defaultClubEmailPolicy('club-1');
    policy.kindEmailEnabled.conclusion = false;
    assert.equal(resolveClubEmailEnabled(policy, 'conclusion', null), false);
    assert.equal(resolveClubEmailEnabled(policy, 'invitation', null), true);
  });

  it('活动粒度覆盖类型粒度（按活动或类型关闭，NTF-004.2）', () => {
    const policy = defaultClubEmailPolicy('club-1');
    policy.kindEmailEnabled.conclusion = false;
    policy.activityEmailEnabled['act-42'] = true; // 该活动显式开启
    assert.equal(resolveClubEmailEnabled(policy, 'conclusion', 'act-42'), true);
    assert.equal(resolveClubEmailEnabled(policy, 'conclusion', 'act-43'), false);
  });

  it('用户偏好：未登记视为开启；登记为 false 时关闭', () => {
    assert.equal(resolveUserEmailEnabled(null, 'interview'), true);
    assert.equal(resolveUserEmailEnabled({ interview: false }, 'interview'), false);
    assert.equal(resolveUserEmailEnabled({ interview: false }, 'conclusion'), true);
  });
});

describe('受保护邮件类别（NTF-004.4 学生不可关闭验证/变更/安全通知）', () => {
  it('受保护类别常量完整', () => {
    assert.deepEqual([...PROTECTED_EMAIL_CATEGORIES].sort(), [
      'email_change',
      'email_verification',
      'security',
    ]);
  });

  it('试图关闭受保护类别被拒绝', () => {
    for (const category of PROTECTED_EMAIL_CATEGORIES) {
      const error = validateEmailPreferenceUpdate({ [category]: false });
      assert.ok(error !== null, category + ' 应被拒绝');
      assert.ok(error?.includes('不可关闭'));
    }
  });

  it('未知 kind 拒绝；合法 kind 布尔值通过', () => {
    assert.ok(validateEmailPreferenceUpdate({ unknown_kind: true })?.includes('未知通知类型'));
    assert.ok(validateEmailPreferenceUpdate({ application: 'yes' })?.includes('布尔'));
    assert.equal(validateEmailPreferenceUpdate({ application: false, interview: true }), null);
  });
});
