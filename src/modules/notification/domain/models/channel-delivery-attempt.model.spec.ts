/**
 * 邮件资格评估与收件人快照解析测试（NTF-002、NTF-004 至 NTF-007）。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { evaluateEmailEligibility, shouldStopEmailRetry } from './channel-delivery-attempt.model';
import { DefaultRecipientSnapshotResolver } from '../services';

describe('邮件资格评估 (NTF-004 至 NTF-007)', () => {
  it('全部条件满足 → 具备资格', () => {
    const result = evaluateEmailEligibility({
      eventAllowsEmail: true,
      configClosedEmail: false,
      userUnsubscribed: false,
      emailVerified: true,
      senderAccountValid: true,
    });
    assert.equal(result.eligible, true);
    assert.equal(result.reason, null);
  });

  it('事件不允许邮件 → 不具资格 (NTF-004)', () => {
    const result = evaluateEmailEligibility({
      eventAllowsEmail: false,
      configClosedEmail: false,
      userUnsubscribed: false,
      emailVerified: true,
      senderAccountValid: true,
    });
    assert.equal(result.eligible, false);
    assert.ok(result.reason);
  });

  it('配置关闭邮件 → 不具资格', () => {
    const result = evaluateEmailEligibility({
      eventAllowsEmail: true,
      configClosedEmail: true,
      userUnsubscribed: false,
      emailVerified: true,
      senderAccountValid: true,
    });
    assert.equal(result.eligible, false);
  });

  it('用户退订普通邮件 → 不具资格', () => {
    const result = evaluateEmailEligibility({
      eventAllowsEmail: true,
      configClosedEmail: false,
      userUnsubscribed: true,
      emailVerified: true,
      senderAccountValid: true,
    });
    assert.equal(result.eligible, false);
  });

  it('邮箱未验证 → 不具资格', () => {
    const result = evaluateEmailEligibility({
      eventAllowsEmail: true,
      configClosedEmail: false,
      userUnsubscribed: false,
      emailVerified: false,
      senderAccountValid: true,
    });
    assert.equal(result.eligible, false);
  });

  it('发信账号无效 → 不具资格', () => {
    const result = evaluateEmailEligibility({
      eventAllowsEmail: true,
      configClosedEmail: false,
      userUnsubscribed: false,
      emailVerified: true,
      senderAccountValid: false,
    });
    assert.equal(result.eligible, false);
  });
});

describe('邮件重试停止条件 (NTF-007)', () => {
  it('明确退信 → 停止重试', () => {
    assert.equal(
      shouldStopEmailRetry({
        responseCategory: 'BOUNCE',
        firstFailureAt: new Date().toISOString(),
        now: new Date().toISOString(),
      }),
      true,
    );
  });

  it('永久失败 → 停止重试', () => {
    assert.equal(
      shouldStopEmailRetry({
        responseCategory: 'PERMANENT_FAILURE',
        firstFailureAt: new Date().toISOString(),
        now: new Date().toISOString(),
      }),
      true,
    );
  });

  it('连续失败超过 24 小时 → 停止重试', () => {
    const firstFailure = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    assert.equal(
      shouldStopEmailRetry({
        responseCategory: 'TEMPORARY_FAILURE',
        firstFailureAt: firstFailure,
        now: new Date().toISOString(),
      }),
      true,
    );
  });

  it('连续失败不足 24 小时 → 继续重试', () => {
    const firstFailure = new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString();
    assert.equal(
      shouldStopEmailRetry({
        responseCategory: 'TEMPORARY_FAILURE',
        firstFailureAt: firstFailure,
        now: new Date().toISOString(),
      }),
      false,
    );
  });
});

describe('收件人快照解析 (NTF-002)', () => {
  const resolver = new DefaultRecipientSnapshotResolver();

  it('权益事件通知学生本人', () => {
    const result = resolver.resolve({
      eventType: 'invitation',
      sourceObjectId: 'inv-001',
      scope: { type: 'CLUB', clubId: 'club-001' },
      operatorId: 'op-001',
      targetStudentId: 'student-001',
    });
    assert.equal(result.recipients.length, 1);
    assert.equal(result.recipients[0].recipientId, 'student-001');
    assert.equal(result.recipients[0].reason, '本人');
  });

  it('无目标学生的权益事件 → 收件人为空', () => {
    const result = resolver.resolve({
      eventType: 'invitation',
      sourceObjectId: 'inv-002',
      scope: { type: 'CLUB', clubId: 'club-001' },
      operatorId: 'op-001',
    });
    assert.equal(result.recipients.length, 0);
  });

  it('管理事件不通知学生本人', () => {
    const result = resolver.resolve({
      eventType: 'system',
      sourceObjectId: 'obj-001',
      scope: { type: 'PLATFORM', clubId: null },
      operatorId: 'op-001',
      targetStudentId: 'student-001',
    });
    assert.equal(result.recipients.length, 0);
  });

  it('收件人快照记录去重键', () => {
    const result = resolver.resolve({
      eventType: 'conclusion',
      sourceObjectId: 'rec-001',
      scope: { type: 'CLUB', clubId: 'club-001' },
      operatorId: 'op-001',
      targetStudentId: 'student-001',
    });
    assert.equal(result.recipients[0].dedupKey, 'rec-001\u0000conclusion\u0000student-001');
  });
});
