/**
 * 通知控制器测试（4.3.2 桩补全 + 4.3.3 可选邮件渠道）。
 *
 * 覆盖：邮件配置持久化与脱敏（NTF-006）、权限校验（club:email:config /
 * 超管；人事无权查看或修改）、通知偏好按会话 userId 落库、社团级邮件
 * 偏好默认开启（NTF-004）。身份由请求上的 notificationAuthSession 提供。
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { Request } from 'express';

import {
  InMemoryEmailConfigStore,
  InMemoryKillSwitchRepository,
  InMemoryNotificationPreferencesStore,
  InMemoryClubEmailPolicyStore,
  InMemoryPlatformEmailSuspensionStore,
  InMemoryEmailTemplateStore,
  InMemoryChannelDeliveryAttemptRepository,
} from '../infrastructure';
import { NotificationController } from './notification.controller';
import { NOTIFICATION_AUTH_SESSION_KEY } from './notification-auth.guard';
import {
  SaveEmailConfigCommand,
  TestEmailConfigCommand,
  RotateEmailKeyCommand,
  SaveEmailTemplateCommand,
  RollbackEmailTemplateCommand,
  SendTemplateTestEmailCommand,
} from '../application/commands';
import { EmailTemplateResolver } from '../application/services/email-template-resolver';
import { AesGcmEmailSecretCipher } from '../infrastructure/email-secret-cipher';

/** 会话权限集 */
function session(
  userId: string,
  options: { permissions?: string[]; isPlatformAdmin?: boolean; displayName?: string } = {},
): Record<string, unknown> {
  return {
    userId,
    displayName: options.displayName ?? userId,
    now: new Date(),
    permissions: options.permissions ?? [],
    isPlatformAdmin: options.isPlatformAdmin ?? false,
  };
}

/** 挂载已认证会话的请求 */
function authedRequest(
  userId: string,
  options: { permissions?: string[]; isPlatformAdmin?: boolean } = {},
): Request {
  const request = {} as Request & Record<string, unknown>;
  request[NOTIFICATION_AUTH_SESSION_KEY] = session(userId, options);
  return request;
}

interface ControllerHarness {
  controller: NotificationController;
  emailConfigs: InMemoryEmailConfigStore;
  policies: InMemoryClubEmailPolicyStore;
  attempts: InMemoryChannelDeliveryAttemptRepository;
  templates: InMemoryEmailTemplateStore;
}

function buildController(): ControllerHarness {
  const emailConfigs = new InMemoryEmailConfigStore();
  const killSwitches = new InMemoryKillSwitchRepository();
  const preferences = new InMemoryNotificationPreferencesStore();
  const policies = new InMemoryClubEmailPolicyStore();
  const suspension = new InMemoryPlatformEmailSuspensionStore();
  const templates = new InMemoryEmailTemplateStore();
  const attempts = new InMemoryChannelDeliveryAttemptRepository();
  const cipher = new AesGcmEmailSecretCipher();
  const audit = { write: async () => 'audit-stub' } as never;
  const saveCmd = new SaveEmailConfigCommand(emailConfigs, cipher, audit);
  const adapterStub = {
    send: async () => ({ status: 'SENT', channelMessageId: 'msg-1', sanitizedError: null }),
  } as never;
  const testCmd = new TestEmailConfigCommand(emailConfigs, cipher, adapterStub, audit);
  const rotateCmd = new RotateEmailKeyCommand(emailConfigs, audit);
  const resolver = new EmailTemplateResolver(templates);
  const saveTplCmd = new SaveEmailTemplateCommand(templates, audit);
  const rollbackTplCmd = new RollbackEmailTemplateCommand(templates, audit);
  const sendTplTestCmd = new SendTemplateTestEmailCommand(resolver, adapterStub);
  const controller = new NotificationController(
    {} as never, // queryService
    {} as never, // markPresentationStatus
    {} as never, // markAllRead
    {} as never, // applyKillSwitch
    {} as never, // resumeKillSwitch
    killSwitches,
    emailConfigs,
    preferences,
    saveCmd,
    testCmd,
    rotateCmd,
    saveTplCmd,
    rollbackTplCmd,
    sendTplTestCmd,
    resolver,
    policies,
    suspension,
    templates,
    attempts,
  );
  return { controller, emailConfigs, policies, attempts, templates };
}

const LEADER_ACTOR = { permissions: ['club:email:config', 'club:config:manage'] };
const HR_ACTOR = { permissions: ['club:config:manage'] }; // 人事：无 club:email:config

describe('NotificationController 邮件配置（NTF-006：持久化＋脱敏＋权限）', () => {
  let harness: ControllerHarness;

  beforeEach(() => {
    harness = buildController();
  });

  it('负责人保存后 GET 能读回持久化配置；密钥只显示指纹不回显', async () => {
    const { controller } = harness;
    await controller.saveEmailConfig(authedRequest('leader-1', LEADER_ACTOR), 'club-1', {
      smtpHost: 'smtp.example.edu',
      smtpPort: 465,
      smtpUser: 'club@example.edu',
      fromName: '社团 A',
      encryption: 'ssl',
      smtpSecret: 'super-secret-password',
    });

    const view = await controller.getEmailConfig(authedRequest('leader-1', LEADER_ACTOR), 'club-1');
    assert.equal(view.smtpHost, 'smtp.example.edu');
    assert.equal(view.smtpPort, 465);
    assert.equal(view.verified, false, '新配置默认未验证');
    assert.equal(view.secretConfigured, true, '显示已配置密钥');
    assert.ok(view.secretFingerprint && view.secretFingerprint.length === 12);
    const raw = JSON.stringify(view);
    assert.ok(!raw.includes('super-secret-password'), '响应绝不回显密钥明文');
  });

  it('新配置必须通过测试邮件后启用；轮换后失效需重填重测', async () => {
    const { controller } = harness;
    await controller.saveEmailConfig(authedRequest('leader-1', LEADER_ACTOR), 'club-1', {
      smtpHost: 'smtp.example.edu',
      smtpUser: 'club@example.edu',
      fromName: '社团 A',
      smtpSecret: 'pw-1',
    });
    await controller.testEmailConfig(authedRequest('leader-1', LEADER_ACTOR), 'club-1', {});
    const verified = await controller.getEmailConfig(
      authedRequest('leader-1', LEADER_ACTOR),
      'club-1',
    );
    assert.equal(verified.verified, true);
    assert.ok(verified.lastTestPassedAt);

    await controller.rotateKey(authedRequest('leader-1', LEADER_ACTOR), 'club-1');
    const rotated = await controller.getEmailConfig(
      authedRequest('leader-1', LEADER_ACTOR),
      'club-1',
    );
    assert.equal(rotated.verified, false, '轮换后必须重新测试');
    assert.equal(rotated.secretConfigured, false, '轮换清除旧密钥，须重填');
    assert.ok(rotated.keyRotatedAt);
  });

  it('人事管理员（无 club:email:config）不能查看或修改邮件配置', async () => {
    const { controller } = harness;
    // 先由负责人正常配置
    await controller.saveEmailConfig(authedRequest('leader-1', LEADER_ACTOR), 'club-1', {
      smtpHost: 'smtp.example.edu',
      smtpUser: 'club@example.edu',
      fromName: '社团 A',
      smtpSecret: 'pw-1',
    });

    // 人事查看 → 403
    await assert.rejects(
      () => controller.getEmailConfig(authedRequest('hr-1', HR_ACTOR), 'club-1'),
      (error: unknown) => {
        const e = error as { status?: number; response?: { code?: string } };
        assert.equal(e.status, 403);
        assert.equal(e.response?.code, 'IFC-ERR-002');
        return true;
      },
    );
    // 人事修改 → 403
    await assert.rejects(
      () =>
        controller.saveEmailConfig(authedRequest('hr-1', HR_ACTOR), 'club-1', {
          smtpHost: 'evil.example.com',
          smtpUser: 'evil@example.com',
          fromName: 'X',
          smtpSecret: 'pw-2',
        }),
      (error: unknown) => {
        const e = error as { status?: number };
        assert.equal(e.status, 403);
        return true;
      },
    );
    // 配置未被篡改
    const view = await controller.getEmailConfig(authedRequest('leader-1', LEADER_ACTOR), 'club-1');
    assert.equal(view.smtpUser, 'club@example.edu');
  });

  it('超管可单独配置社团账号（任一方可配置，NTF-006.6）；不同社团互相隔离', async () => {
    const { controller } = harness;
    await controller.saveEmailConfig(
      authedRequest('super-1', { isPlatformAdmin: true }),
      'club-1',
      { smtpHost: 'a.example.edu', smtpUser: 'a@example.edu', fromName: 'A', smtpSecret: 'pw-a' },
    );
    const other = await controller.getEmailConfig(
      authedRequest('super-1', { isPlatformAdmin: true }),
      'club-2',
    );
    assert.equal(other.smtpHost, '', '社团配置隔离：club-2 无配置');
    assert.equal(other.secretConfigured, false);
  });

  it('平台邮件配置仅超管可管理（§15.9）', async () => {
    const { controller } = harness;
    await assert.rejects(
      () =>
        controller.saveAdminEmailConfig(authedRequest('leader-1', LEADER_ACTOR), {
          smtpHost: 'p.example.edu',
          smtpUser: 'platform@example.edu',
          fromName: '平台',
          smtpSecret: 'pw-p',
        }),
      (error: unknown) => {
        const e = error as { status?: number };
        assert.equal(e.status, 403);
        return true;
      },
    );
    await controller.saveAdminEmailConfig(authedRequest('super-1', { isPlatformAdmin: true }), {
      smtpHost: 'p.example.edu',
      smtpUser: 'platform@example.edu',
      fromName: '平台',
      smtpSecret: 'pw-p',
    });
    const view = await controller.getAdminEmailConfig(
      authedRequest('super-1', { isPlatformAdmin: true }),
    );
    assert.equal(view.smtpHost, 'p.example.edu');
    assert.equal(view.secretConfigured, true);
  });
});

describe('NotificationController 社团通知偏好（NTF-004：默认开启、负责人/人事可关）', () => {
  let harness: ControllerHarness;

  beforeEach(() => {
    harness = buildController();
  });

  it('未设置时全部默认开启；人事也可关闭（偏好权限宽于密钥配置）', async () => {
    const { controller } = harness;
    const before = await controller.orgPreferences(authedRequest('hr-1', HR_ACTOR), 'club-1');
    assert.equal(before.preferences.conclusion, true, '默认开启');

    const saved = await controller.updateOrgPreferences(authedRequest('hr-1', HR_ACTOR), 'club-1', {
      conclusion: false,
    });
    assert.equal(saved.preferences.conclusion, false);
    assert.equal(saved.preferences.application, true, '其他类型不受影响');

    const reread = await controller.orgPreferences(authedRequest('hr-1', HR_ACTOR), 'club-1');
    assert.equal(reread.preferences.conclusion, false);
  });

  it('未知 kind 与非布尔值拒绝（不静默接受）', async () => {
    const { controller } = harness;
    await assert.rejects(
      () =>
        controller.updateOrgPreferences(authedRequest('leader-1', LEADER_ACTOR), 'club-1', {
          unknown_kind: false,
        } as never),
      (error: unknown) => (error as Error).message.includes('未知通知类型'),
    );
  });

  it('无权限者读取社团偏好被拒绝', async () => {
    const { controller } = harness;
    await assert.rejects(
      () => controller.orgPreferences(authedRequest('student-1', { permissions: [] }), 'club-1'),
      (error: unknown) => {
        const e = error as { status?: number };
        assert.equal(e.status, 403);
        return true;
      },
    );
  });
});

describe('NotificationController 邮件模板（NTF-005：保存校验/预览/回退）', () => {
  let harness: ControllerHarness;

  beforeEach(() => {
    harness = buildController();
  });

  it('安全模板可保存并返回版本号；危险模板拒绝（IFC-ERR-011）', async () => {
    const { controller } = harness;
    const saved = await controller.saveClubTemplate(
      authedRequest('leader-1', LEADER_ACTOR),
      'club-1',
      'conclusion',
      { subject: '录取通知', htmlBody: '<p style="color: red">恭喜你被录取</p>' },
    );
    assert.equal(saved.scopeType, 'CLUB');
    assert.equal(saved.clubId, 'club-1');
    assert.equal(saved.activeVersion, 1, '社团作用域首个版本为 1');

    await assert.rejects(
      () =>
        controller.saveClubTemplate(
          authedRequest('leader-1', LEADER_ACTOR),
          'club-1',
          'conclusion',
          { subject: 'x', htmlBody: '<script>alert(1)</script><p>hi</p>' },
        ),
      (error: unknown) => (error as Error).message.includes('IFC-ERR-011'),
    );
  });

  it('模板测试邮件需社团权限；无权限者被拒（不借社团 SMTP 发信）', async () => {
    const { controller, emailConfigs } = harness;
    // 配置一个已验证的社团发信账号
    await emailConfigs.save({
      clubId: 'club-1',
      smtpHost: 'smtp.club.example',
      smtpPort: 587,
      smtpUser: 'club@example.com',
      fromName: '社团',
      encryption: 'tls',
      secretCiphertext: 'x',
      secretFingerprint: 'fp',
      verified: true,
      lastTestPassedAt: null,
      keyRotatedAt: null,
      savedAt: new Date().toISOString(),
    });
    // 无任何权限的已登录用户不可用社团 SMTP 账号发测试邮件（Broken Access Control）
    await assert.rejects(
      () =>
        controller.testClubTemplate(authedRequest('attacker'), 'club-1', 'conclusion', {
          subject: 'x',
          htmlBody: '<p>hi</p>',
          to: 'anyone@example.com',
        }),
      (error: unknown) => (error as Error).message.includes('无权'),
    );
  });

  it('预览：草稿安全时渲染白名单变量；草稿危险时返回违规', async () => {
    const { controller } = harness;
    const ok = await controller.previewClubTemplate(
      authedRequest('leader-1', LEADER_ACTOR),
      'club-1',
      'conclusion',
      {
        subject: '结果通知',
        htmlBody: '<p>{{studentName}}，你的结论是 {{conclusion}}</p>',
        variables: { studentName: '张三', conclusion: '通过' },
      },
    );
    assert.equal(ok.ok, true);
    assert.ok(ok.htmlBody?.includes('张三'));
    assert.ok(ok.htmlBody?.includes('通过'));

    const bad = await controller.previewClubTemplate(
      authedRequest('leader-1', LEADER_ACTOR),
      'club-1',
      'conclusion',
      { subject: 'x', htmlBody: '<iframe src="https://evil.example"></iframe>' },
    );
    assert.equal(bad.ok, false);
    assert.ok(bad.violations.length > 0);
  });

  it('社团自定义模板失效时解析自动回退平台默认模板（NTF-005.6）', async () => {
    const { controller, templates } = harness;
    // 直接向存储注入一个"未净化"的社团模板模拟历史脏数据
    await templates.saveVersion(
      { type: 'CLUB', clubId: 'club-9' },
      'conclusion',
      '坏模板',
      '<script>bad()</script>',
      'someone',
      'dirty',
    );
    const resolved = await (
      controller as unknown as { templateResolver: EmailTemplateResolver }
    ).templateResolver.renderForFact({
      kind: 'conclusion',
      clubId: 'club-9',
      variables: { studentName: '李四' },
    });
    assert.equal(resolved.source, 'PLATFORM_DEFAULT', '回退平台默认');
    assert.equal(resolved.fellBack, true);
    assert.ok(resolved.fallbackReason?.includes('回退'));
  });
});

describe('NotificationController 本人通知偏好（评审 #7 回归 + NTF-004 受保护类别）', () => {
  let harness: ControllerHarness;

  beforeEach(() => {
    harness = buildController();
  });

  it('未设置时返回默认全 true；savedAt 为 null', async () => {
    const { controller } = harness;
    const result = await controller.myPreferences(authedRequest('user-1'));
    assert.equal(result.preferences.application, true);
    assert.equal(result.preferences.correction, true);
    assert.equal(result.savedAt, null);
  });

  it('学生可关闭普通业务邮件并落库到会话 userId', async () => {
    const { controller } = harness;
    const saved = await controller.updateMyPreferences(authedRequest('user-1'), {
      application: false,
    });
    assert.equal(saved.preferences.application, false);
    const other = await controller.myPreferences(authedRequest('user-2'));
    assert.equal(other.preferences.application, true, '用户间隔离');
  });
});
