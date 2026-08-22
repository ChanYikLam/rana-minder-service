/**
 * 通知控制器功能桩补全测试（评审 #6 邮件配置持久化、#7 通知偏好
 * 按会话 userId 真实落库）。
 *
 * 直接实例化控制器，注入内存存储与桩命令；身份由请求上的
 * notificationAuthSession 提供（controller 本身不信任客户端参数）。
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { ForbiddenException } from '@nestjs/common';
import type { Request } from 'express';

import {
  InMemoryEmailConfigStore,
  InMemoryKillSwitchRepository,
  InMemoryNotificationPreferencesStore,
  InMemoryNotificationRepository,
  InMemoryPrivilegedAuditWriter,
  FailClosedNotificationPrivilegeVerifier,
} from '../infrastructure';
import { NotificationController } from './notification.controller';
import { NOTIFICATION_AUTH_SESSION_KEY } from './notification-auth.guard';
import { ApplyKillSwitchCommand } from '../application/commands';
import type { KillSwitchScope } from '../domain';
import type { NotificationPrivilegeVerifier } from '../infrastructure';

/** 挂载已认证会话的请求 */
function authedRequest(userId: string, displayName = userId): Request {
  const request = {} as Request & Record<string, unknown>;
  request[NOTIFICATION_AUTH_SESSION_KEY] = {
    userId,
    displayName,
    now: new Date(),
  };
  return request;
}

describe('NotificationController 邮件配置（评审 #6：持久化）', () => {
  let controller: NotificationController;
  let emailConfigs: InMemoryEmailConfigStore;

  beforeEach(() => {
    emailConfigs = new InMemoryEmailConfigStore();
    controller = new NotificationController(
      {} as never, // queryService（本组用例不使用）
      {} as never, // markPresentationStatus
      {} as never, // markAllRead
      {} as never, // applyKillSwitch
      {} as never, // resumeKillSwitch
      new InMemoryKillSwitchRepository(),
      emailConfigs,
      new InMemoryNotificationPreferencesStore(),
      new FailClosedNotificationPrivilegeVerifier(),
    );
  });

  it('保存后 GET 能读回持久化的配置（不再恒回显默认空值）', async () => {
    await controller.saveEmailConfig('club-1', {
      smtpHost: 'smtp.example.edu',
      smtpPort: 465,
      smtpUser: 'club@example.edu',
      fromName: '社团 A',
      encryption: 'ssl',
    });

    const view = await controller.getEmailConfig('club-1');
    assert.equal(view.smtpHost, 'smtp.example.edu');
    assert.equal(view.smtpPort, 465);
    assert.equal(view.smtpUser, 'club@example.edu');
    assert.equal(view.fromName, '社团 A');
    assert.equal(view.encryption, 'ssl');
    assert.equal(view.verified, false, '新配置默认未验证');
  });

  it('测试通过后 verified=true；轮换后 verified=false', async () => {
    await controller.saveEmailConfig('club-1', {
      smtpHost: 'smtp.example.edu',
      smtpUser: 'club@example.edu',
      fromName: '社团 A',
    });
    await controller.testEmailConfig('club-1');
    const verified = await controller.getEmailConfig('club-1');
    assert.equal(verified.verified, true);
    assert.ok(verified.lastTestPassedAt);

    await controller.rotateKey('club-1');
    const rotated = await controller.getEmailConfig('club-1');
    assert.equal(rotated.verified, false);
    assert.ok(rotated.keyRotatedAt);
  });

  it('不同社团配置互相隔离', async () => {
    await controller.saveEmailConfig('club-1', {
      smtpHost: 'a.example.edu',
      smtpUser: 'a@example.edu',
      fromName: 'A',
    });
    const other = await controller.getEmailConfig('club-2');
    assert.equal(other.smtpHost, '');
  });
});

describe('NotificationController 通知偏好（评审 #7：按会话 userId 落库）', () => {
  let controller: NotificationController;
  let preferences: InMemoryNotificationPreferencesStore;

  beforeEach(() => {
    preferences = new InMemoryNotificationPreferencesStore();
    controller = new NotificationController(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      new InMemoryKillSwitchRepository(),
      new InMemoryEmailConfigStore(),
      preferences,
      new FailClosedNotificationPrivilegeVerifier(),
    );
  });

  it('未设置时返回默认全 true；savedAt 为 null', async () => {
    const result = await controller.myPreferences(authedRequest('user-1'));
    assert.equal(result.preferences.application, true);
    assert.equal(result.preferences.correction, true);
    assert.equal(result.savedAt, null);
  });

  it('更新后按会话用户持久化，GET 读回更新值', async () => {
    await controller.updateMyPreferences(authedRequest('user-1'), {
      application: false,
      interview: false,
    });
    const result = await controller.myPreferences(authedRequest('user-1'));
    assert.equal(result.preferences.application, false);
    assert.equal(result.preferences.interview, false);
    assert.equal(result.preferences.invitation, true, '未更新的 kind 保持默认');
    assert.ok(result.savedAt);
  });

  it('不同用户偏好隔离（userId 取自会话，非客户端参数）', async () => {
    await controller.updateMyPreferences(authedRequest('user-1'), {
      application: false,
    });
    const other = await controller.myPreferences(authedRequest('user-2'));
    assert.equal(other.preferences.application, true, 'user-2 不受 user-1 影响');
  });
});

describe('NotificationController 站内信紧急关闭授权（XCC-FAIL-009：越权防护）', () => {
  it('fail-closed：任意已登录用户执行社团级关闭被拒绝（403）', async () => {
    const controller = new NotificationController(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      new InMemoryKillSwitchRepository(),
      new InMemoryEmailConfigStore(),
      new InMemoryNotificationPreferencesStore(),
      new FailClosedNotificationPrivilegeVerifier(),
    );
    await assert.rejects(
      controller.clubKillSwitch(authedRequest('user-1'), 'club-1', {
        active: true,
        reason: '维护',
        confirmed: true,
        expectedRecoveryAt: new Date(Date.now() + 3600_000).toISOString(),
      }),
      ForbiddenException,
    );
  });

  it('fail-closed：任意已登录用户执行平台级关闭被拒绝（403）', async () => {
    const controller = new NotificationController(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      new InMemoryKillSwitchRepository(),
      new InMemoryEmailConfigStore(),
      new InMemoryNotificationPreferencesStore(),
      new FailClosedNotificationPrivilegeVerifier(),
    );
    await assert.rejects(
      controller.platformKillSwitch(authedRequest('user-1'), {
        active: true,
        reason: '维护',
        confirmed: true,
        expectedRecoveryAt: new Date(Date.now() + 3600_000).toISOString(),
      }),
      ForbiddenException,
    );
  });

  it('授权通过：超管执行社团级关闭走真实命令并落库关闭状态', async () => {
    const allowAll: NotificationPrivilegeVerifier = {
      async canOperateKillSwitch(
        _scope: KillSwitchScope,
        _clubId: string | null,
        _subjectId: string,
      ): Promise<boolean> {
        return true;
      },
    };
    const killSwitches = new InMemoryKillSwitchRepository();
    const apply = new ApplyKillSwitchCommand(
      new InMemoryNotificationRepository(),
      killSwitches,
      new InMemoryPrivilegedAuditWriter(),
    );
    const controller = new NotificationController(
      {} as never,
      {} as never,
      {} as never,
      apply,
      {} as never,
      killSwitches,
      new InMemoryEmailConfigStore(),
      new InMemoryNotificationPreferencesStore(),
      allowAll,
    );
    const state = await controller.clubKillSwitch(authedRequest('admin-1', '管理员'), 'club-9', {
      active: true,
      reason: '系统维护',
      confirmed: true,
      expectedRecoveryAt: new Date(Date.now() + 3600_000).toISOString(),
    });
    assert.equal(state.active, true);
    assert.equal(state.scope, 'club');
    assert.equal(state.clubId, 'club-9');
    const saved = await killSwitches.findByScope('CLUB', 'club-9');
    assert.ok(saved?.active);
    assert.equal(saved?.operatorName, '管理员');
  });
});
