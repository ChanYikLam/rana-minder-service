/**
 * 可选邮件渠道编排命令测试（NTF-004 至 NTF-007 核心）。
 *
 * 关键断言：
 * - 无论邮件是否发送，站内信必须创建（NTF-004.3/4 邮件不能替代站内信）；
 * - 资格链任一层关闭 → 只发站内信；
 * - 社团无有效发信配置 → 只发站内信（NTF-006 不能借用）；
 * - 邮件失败不影响已创建的站内信，也不回滚业务（NTF-007）。
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  InMemoryNotificationRepository,
  InMemoryInboxAdapter,
  InMemoryEmailConfigStore,
  InMemoryClubEmailPolicyStore,
  InMemoryPlatformEmailSuspensionStore,
  InMemoryNotificationPreferencesStore,
  InMemoryChannelDeliveryAttemptRepository,
  InMemoryTemplateSnapshotService,
} from '../../infrastructure';
import { CreateEmailAttemptCommand } from './create-email-attempt.command';
import { DispatchOptionalEmailCommand } from './dispatch-optional-email.command';
import { EmailTemplateResolver } from '../services/email-template-resolver';
import { InMemoryEmailTemplateStore } from '../../infrastructure/in-memory-notification-adapters';

/** 可控结果的邮件适配器桩 */
class StubEmailAdapter {
  public nextResult: {
    status: string;
    channelMessageId: string | null;
    sanitizedError: string | null;
  } = {
    status: 'SENT',
    channelMessageId: 'msg-ok',
    sanitizedError: null,
  };
  public calls: unknown[] = [];
  async send(input: unknown) {
    this.calls.push(input);
    return this.nextResult;
  }
}

function buildFact(
  repo: InMemoryNotificationRepository,
  scope?: { type: 'CLUB' | 'PLATFORM' | 'JOINT'; clubId: string | null },
) {
  const logicalEventId = 'evt-' + Math.random().toString(36).slice(2) + '-' + Date.now();
  return repo.saveFactWithSnapshots(
    {
      logicalEventId,
      sourceObjectId: 'application-1',
      sourceObjectVersion: 1,
      sourceCommandId: 'cmd-1',
      eventType: 'conclusion',
      eventTime: new Date().toISOString(),
      summary: '你在「2026 秋季招新」的结论为：通过',
      targetObjectRef: '/recruitment/apply/1',
      deadlineAt: null,
      scope: scope ?? { type: 'CLUB', clubId: 'club-1' },
    },
    [
      {
        snapshotId: '',
        factId: '',
        recipientId: 'student-1',
        reason: '本人',
        dedupKey: logicalEventId + ':student-1',
        scope: scope ?? { type: 'CLUB', clubId: 'club-1' },
        createdAt: new Date().toISOString(),
      },
    ],
  );
}

describe('DispatchOptionalEmailCommand（NTF-004 邮件为附加渠道）', () => {
  let repo: InMemoryNotificationRepository;
  let inbox: InMemoryInboxAdapter;
  let configs: InMemoryEmailConfigStore;
  let policies: InMemoryClubEmailPolicyStore;
  let suspension: InMemoryPlatformEmailSuspensionStore;
  let prefs: InMemoryNotificationPreferencesStore;
  let attempts: InMemoryChannelDeliveryAttemptRepository;
  let adapter: StubEmailAdapter;
  let dispatcher: DispatchOptionalEmailCommand;

  beforeEach(() => {
    repo = new InMemoryNotificationRepository();
    inbox = new InMemoryInboxAdapter();
    configs = new InMemoryEmailConfigStore();
    policies = new InMemoryClubEmailPolicyStore();
    suspension = new InMemoryPlatformEmailSuspensionStore();
    prefs = new InMemoryNotificationPreferencesStore();
    attempts = new InMemoryChannelDeliveryAttemptRepository();
    adapter = new StubEmailAdapter();
    const templates = new InMemoryEmailTemplateStore();
    const createEmailAttempt = new CreateEmailAttemptCommand(
      repo,
      attempts,
      adapter as never,
      new InMemoryTemplateSnapshotService(),
    );
    dispatcher = new DispatchOptionalEmailCommand(
      repo,
      inbox,
      configs,
      policies,
      suspension,
      prefs,
      createEmailAttempt,
      new EmailTemplateResolver(templates),
    );
  });

  async function giveClubValidConfig(): Promise<void> {
    await configs.save({
      clubId: 'club-1',
      smtpHost: 'smtp.club.edu',
      smtpPort: 465,
      smtpUser: 'club@club.edu',
      fromName: '动漫社',
      encryption: 'ssl',
      secretCiphertext: 'cipher-text',
      secretFingerprint: 'fp1234567890',
      verified: true,
      lastTestPassedAt: new Date().toISOString(),
      keyRotatedAt: null,
      savedAt: new Date().toISOString(),
    });
  }

  it('资格全部满足：站内信＋邮件都创建；邮件使用社团署名与模板渲染', async () => {
    await giveClubValidConfig();
    const { fact } = await buildFact(repo);
    const result = await dispatcher.execute({
      factId: fact.factId,
      recipientId: 'student-1',
      recipientEmail: 'student@student.edu',
      emailVerified: true,
      templateVariables: { studentName: '张三', conclusion: '通过' },
    });

    assert.ok(result.inboxPresentationId, '站内信必须创建（权威渠道）');
    assert.ok(result.emailAttempt, '邮件任务应创建');
    assert.equal(result.emailSkipReason, null);
    // 站内信内容来自事实摘要（最少信息）
    const presentation = await inbox.findPresentation(result.inboxPresentationId!);
    assert.ok(presentation?.body.includes('结论为：通过'));
    // 邮件经模板管道渲染（平台默认模板含占位符替换）
    assert.equal(adapter.calls.length, 1);
    const sent = adapter.calls[0] as {
      subject: string;
      body: string;
      replyTo: string;
      senderIdentity: string;
    };
    assert.ok(sent.subject.includes('动漫社') || sent.subject.includes('招新结果通知'));
    assert.ok(sent.replyTo === 'club@club.edu', '回复地址固定为实际发信账号（NTF-009）');
    assert.ok(sent.senderIdentity.includes('动漫社'), '社团独立邮件用社团展示名（NTF-008）');
  });

  it('未选邮件/用户退订/邮箱未验证：只建站内信，不建邮件', async () => {
    await giveClubValidConfig();
    const cases: Array<{ patch: Record<string, unknown>; reasonIncludes: string }> = [
      { patch: { skipEmailThisTime: true }, reasonIncludes: '已取消邮件' },
      { patch: { emailVerified: false }, reasonIncludes: '邮箱未验证' },
    ];
    for (const testCase of cases) {
      const { fact } = await buildFact(repo);
      const result = await dispatcher.execute({
        factId: fact.factId,
        recipientId: 'student-1',
        recipientEmail: 'student@student.edu',
        emailVerified: true,
        ...testCase.patch,
      });
      assert.ok(result.inboxPresentationId, '站内信仍必须创建');
      assert.equal(result.emailAttempt, null);
      assert.ok(result.emailSkipReason?.includes(testCase.reasonIncludes));
    }

    // 用户偏好关闭普通业务邮件
    await prefs.set('student-1', { conclusion: false });
    const { fact } = await buildFact(repo);
    const result = await dispatcher.execute({
      factId: fact.factId,
      recipientId: 'student-1',
      recipientEmail: 'student@student.edu',
      emailVerified: true,
    });
    assert.ok(result.inboxPresentationId);
    assert.equal(result.emailAttempt, null);
    assert.ok(result.emailSkipReason?.includes('用户已关闭'));
  });

  it('社团策略按类型关闭 → 只发站内信（NTF-004.2）', async () => {
    await giveClubValidConfig();
    await policies.save({
      clubId: 'club-1',
      kindEmailEnabled: { conclusion: false },
      activityEmailEnabled: {},
      updatedBy: 'leader-1',
      updatedAt: new Date().toISOString(),
    });
    const { fact } = await buildFact(repo);
    const result = await dispatcher.execute({
      factId: fact.factId,
      recipientId: 'student-1',
      recipientEmail: 'student@student.edu',
      emailVerified: true,
    });
    assert.ok(result.inboxPresentationId);
    assert.equal(result.emailAttempt, null);
    assert.ok(result.emailSkipReason?.includes('社团策略'));

    // 活动粒度覆盖：该活动显式开启则恢复
    await policies.save({
      clubId: 'club-1',
      kindEmailEnabled: { conclusion: false },
      activityEmailEnabled: { 'act-42': true },
      updatedBy: 'leader-1',
      updatedAt: new Date().toISOString(),
    });
    const { fact: fact2 } = await buildFact(repo);
    const result2 = await dispatcher.execute({
      factId: fact2.factId,
      recipientId: 'student-1',
      recipientEmail: 'student@student.edu',
      emailVerified: true,
      activityId: 'act-42',
    });
    assert.ok(result2.emailAttempt, '活动粒度覆盖类型粒度');
  });

  it('超管统一停用某类邮件 → 全部社团该类型只发站内信（NTF-004.3）', async () => {
    await giveClubValidConfig();
    await suspension.set({ conclusion: false });
    const { fact } = await buildFact(repo);
    const result = await dispatcher.execute({
      factId: fact.factId,
      recipientId: 'student-1',
      recipientEmail: 'student@student.edu',
      emailVerified: true,
    });
    assert.equal(result.emailAttempt, null);
    assert.ok(result.inboxPresentationId);
  });

  it('社团无有效发信配置 → 只能发站内信，不能借用其他社团密钥（NTF-006）', async () => {
    // 只有 club-2 有配置
    await configs.save({
      clubId: 'club-2',
      smtpHost: 'smtp.other.edu',
      smtpPort: 465,
      smtpUser: 'other@club.edu',
      fromName: '其他社',
      encryption: 'ssl',
      secretCiphertext: 'cipher-other',
      secretFingerprint: 'fpotherrrrrr',
      verified: true,
      lastTestPassedAt: new Date().toISOString(),
      keyRotatedAt: null,
      savedAt: new Date().toISOString(),
    });
    const { fact } = await buildFact(repo); // club-1 的事实
    const result = await dispatcher.execute({
      factId: fact.factId,
      recipientId: 'student-1',
      recipientEmail: 'student@student.edu',
      emailVerified: true,
    });
    assert.ok(result.inboxPresentationId, '站内信不受影响');
    assert.equal(result.emailAttempt, null);
    assert.ok(result.emailSkipReason?.includes('无有效发信配置'));
    assert.equal(adapter.calls.length, 0, '绝不借用其他社团账号发送');
  });

  it('邮件发送失败：站内信已创建且业务不回滚（NTF-007），尝试进入重试', async () => {
    await giveClubValidConfig();
    adapter.nextResult = {
      status: 'TEMPORARY_FAILURE',
      channelMessageId: null,
      sanitizedError: 'smtp timeout',
    };
    const { fact } = await buildFact(repo);
    const result = await dispatcher.execute({
      factId: fact.factId,
      recipientId: 'student-1',
      recipientEmail: 'student@student.edu',
      emailVerified: true,
    });
    assert.ok(result.inboxPresentationId, '站内信先于邮件创建且保留');
    assert.ok(result.emailAttempt);
    const stored = await attempts.findAttemptById(result.emailAttempt!.attemptId);
    assert.equal(stored?.status, 'FAILED_RETRY', '临时失败进入重试队列');
    assert.ok(stored?.firstFailedAt, '记录首次失败时间（24h 窗口起点）');
    assert.ok(stored?.emailBody && stored.emailBody.length > 0, '内容快照非空（重试不发空邮件）');
  });

  it('明确退信 → 直接永久失败并停止重试（NTF-007）', async () => {
    await giveClubValidConfig();
    adapter.nextResult = {
      status: 'BOUNCE',
      channelMessageId: null,
      sanitizedError: '554 delivery error',
    };
    const { fact } = await buildFact(repo);
    const result = await dispatcher.execute({
      factId: fact.factId,
      recipientId: 'student-1',
      recipientEmail: 'student@student.edu',
      emailVerified: true,
    });
    const stored = await attempts.findAttemptById(result.emailAttempt!.attemptId);
    assert.equal(stored?.status, 'PERMANENT_FAILURE');
    assert.equal(stored?.responseCategory, 'BOUNCE');
  });

  it('PLATFORM 作用域事件使用平台发信账号与平台展示名（NTF-008.2）', async () => {
    await configs.save({
      clubId: '__platform__',
      smtpHost: 'smtp.platform.edu',
      smtpPort: 465,
      smtpUser: 'platform@platform.edu',
      fromName: 'RanaMinder 平台',
      encryption: 'ssl',
      secretCiphertext: 'cipher-platform',
      secretFingerprint: 'fpplatforrrrr',
      verified: true,
      lastTestPassedAt: new Date().toISOString(),
      keyRotatedAt: null,
      savedAt: new Date().toISOString(),
    });
    const { fact } = await buildFact(repo, { type: 'JOINT', clubId: null });
    const result = await dispatcher.execute({
      factId: fact.factId,
      recipientId: 'student-1',
      recipientEmail: 'student@student.edu',
      emailVerified: true,
    });
    assert.ok(result.emailAttempt);
    const sent = adapter.calls[0] as { replyTo: string; senderIdentity: string };
    assert.equal(sent.replyTo, 'platform@platform.edu');
    assert.ok(sent.senderIdentity.includes('RanaMinder 平台'));
  });
});
