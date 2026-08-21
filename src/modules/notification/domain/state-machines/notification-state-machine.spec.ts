/**
 * 通知状态机测试（SRS-SM-NTF-001）。
 *
 * 覆盖 10 条转换规则，验证 NTF-001 至 NTF-007 及 IFC-TX-002/005 的核心约束。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { NotificationStateMachine } from './notification-state-machine';

describe('NotificationStateMachine (SRS-SM-NTF-001)', () => {
  const sm = new NotificationStateMachine();

  describe('转换 1：权益业务命令创建通知事实', () => {
    it('新建 + 站内信开启 → 已创建＋待投递 (NTF-001)', () => {
      const result = sm.evaluate({
        type: 'CREATE_NOTIFICATION_FACT',
        currentStatus: 'NEW' as any,
        inboxKilled: false,
      });
      assert.equal(result.allowed, true);
      assert.equal(result.newStatus, 'CREATED_PENDING_DELIVERY');
    });

    it('新建 + 站内信紧急关闭 → 已创建＋暂停投递 (NTF-001, SRS-FAIL-009)', () => {
      const result = sm.evaluate({
        type: 'CREATE_NOTIFICATION_FACT',
        currentStatus: 'NEW' as any,
        inboxKilled: true,
      });
      assert.equal(result.allowed, true);
      assert.equal(result.newStatus, 'CREATED_PAUSED_DELIVERY');
    });

    it('已存在通知事实 → 拒绝重复创建 (NTF-003)', () => {
      const result = sm.evaluate({
        type: 'CREATE_NOTIFICATION_FACT',
        currentStatus: 'CREATED_PENDING_DELIVERY',
        inboxKilled: false,
      });
      assert.equal(result.allowed, false);
      assert.ok(result.reason?.includes('不可重复'));
    });
  });

  describe('转换 2：超级管理员紧急关闭站内信', () => {
    it('已创建＋待投递 → 已创建＋暂停投递 (NTF-001)', () => {
      const result = sm.evaluate({
        type: 'KILL_INBOX',
        currentStatus: 'CREATED_PENDING_DELIVERY',
      });
      assert.equal(result.allowed, true);
      assert.equal(result.newStatus, 'CREATED_PAUSED_DELIVERY');
    });

    it('已投递 → 拒绝暂停（已投递通知不可暂停）', () => {
      const result = sm.evaluate({
        type: 'KILL_INBOX',
        currentStatus: 'DELIVERED',
      });
      assert.equal(result.allowed, false);
    });
  });

  describe('转换 3：站内信服务恢复', () => {
    it('已创建＋暂停投递 → 待投递 (NTF-001)', () => {
      const result = sm.evaluate({
        type: 'RESUME_INBOX',
        currentStatus: 'CREATED_PAUSED_DELIVERY',
      });
      assert.equal(result.allowed, true);
      assert.equal(result.newStatus, 'CREATED_PENDING_DELIVERY');
    });

    it('非暂停状态 → 拒绝恢复', () => {
      const result = sm.evaluate({
        type: 'RESUME_INBOX',
        currentStatus: 'DELIVERED',
      });
      assert.equal(result.allowed, false);
    });
  });

  describe('转换 4：系统站内信任务投递', () => {
    it('已创建＋待投递 → 已投递 (NTF-001)', () => {
      const result = sm.evaluate({
        type: 'DELIVER_INBOX',
        currentStatus: 'CREATED_PENDING_DELIVERY',
      });
      assert.equal(result.allowed, true);
      assert.equal(result.newStatus, 'DELIVERED');
      assert.equal(result.newChannelStatus, 'DELIVERED');
      assert.equal(result.newPresentationStatus, 'UNREAD');
    });

    it('暂停投递 → 拒绝投递', () => {
      const result = sm.evaluate({
        type: 'DELIVER_INBOX',
        currentStatus: 'CREATED_PAUSED_DELIVERY',
      });
      assert.equal(result.allowed, false);
    });

    it('已投递 → 幂等允许（重复投递返回原结果）', () => {
      const result = sm.evaluate({
        type: 'DELIVER_INBOX',
        currentStatus: 'DELIVERED',
      });
      assert.equal(result.allowed, true);
      assert.equal(result.newStatus, 'DELIVERED');
    });
  });

  describe('转换 5：收件人标记已读/已处理/隐藏', () => {
    it('已投递 → 已读 (NTF-003)', () => {
      const result = sm.evaluate({
        type: 'MARK_READ',
        currentStatus: 'DELIVERED',
      });
      assert.equal(result.allowed, true);
      assert.equal(result.newPresentationStatus, 'READ');
    });

    it('未投递 → 拒绝已读', () => {
      const result = sm.evaluate({
        type: 'MARK_READ',
        currentStatus: 'CREATED_PENDING_DELIVERY',
      });
      assert.equal(result.allowed, false);
    });

    it('已投递 → 已处理', () => {
      const result = sm.evaluate({
        type: 'MARK_PROCESSED',
        currentStatus: 'DELIVERED',
      });
      assert.equal(result.allowed, true);
      assert.equal(result.newPresentationStatus, 'PROCESSED');
    });

    it('已投递 → 隐藏', () => {
      const result = sm.evaluate({
        type: 'MARK_HIDDEN',
        currentStatus: 'DELIVERED',
      });
      assert.equal(result.allowed, true);
      assert.equal(result.newPresentationStatus, 'HIDDEN');
    });

    it('已隐藏 → 拒绝逆回为已读（呈现状态不可逆）', () => {
      const result = sm.evaluate({
        type: 'MARK_READ',
        currentStatus: 'DELIVERED',
        currentPresentationStatus: 'HIDDEN',
      });
      assert.equal(result.allowed, false);
    });

    it('已处理 → 拒绝逆回为已读（呈现状态不可逆）', () => {
      const result = sm.evaluate({
        type: 'MARK_READ',
        currentStatus: 'DELIVERED',
        currentPresentationStatus: 'PROCESSED',
      });
      assert.equal(result.allowed, false);
    });

    it('已隐藏 → 拒绝标记为已处理', () => {
      const result = sm.evaluate({
        type: 'MARK_PROCESSED',
        currentStatus: 'DELIVERED',
        currentPresentationStatus: 'HIDDEN',
      });
      assert.equal(result.allowed, false);
    });

    it('未读 → 标记已读（正常路径）', () => {
      const result = sm.evaluate({
        type: 'MARK_READ',
        currentStatus: 'DELIVERED',
        currentPresentationStatus: 'UNREAD',
      });
      assert.equal(result.allowed, true);
      assert.equal(result.newPresentationStatus, 'READ');
    });

    it('已读 → 重复标记已读（幂等允许）', () => {
      const result = sm.evaluate({
        type: 'MARK_READ',
        currentStatus: 'DELIVERED',
        currentPresentationStatus: 'READ',
      });
      assert.equal(result.allowed, true);
      assert.equal(result.newPresentationStatus, 'READ');
    });
  });

  describe('转换 8：临时投递失败 → 失败重试', () => {
    it('待投递（邮件）→ 失败重试 (NTF-007)', () => {
      const result = sm.evaluate({
        type: 'RETRY_FAILURE',
        currentStatus: 'CREATED_PENDING_DELIVERY',
        currentChannelStatus: 'PENDING',
        channel: 'EMAIL',
      });
      assert.equal(result.allowed, true);
      assert.equal(result.newChannelStatus, 'FAILED_RETRY');
    });

    it('失败重试 → 失败重试（继续重试）', () => {
      const result = sm.evaluate({
        type: 'RETRY_FAILURE',
        currentStatus: 'CREATED_PENDING_DELIVERY',
        currentChannelStatus: 'FAILED_RETRY',
        channel: 'EMAIL',
      });
      assert.equal(result.allowed, true);
      assert.equal(result.newChannelStatus, 'FAILED_RETRY');
    });
  });

  describe('转换 9：明确退信或连续失败 24 小时 → 永久失败', () => {
    it('失败重试 → 永久失败 (NTF-007)', () => {
      const result = sm.evaluate({
        type: 'MARK_PERMANENT_FAILURE',
        currentStatus: 'CREATED_PENDING_DELIVERY',
        currentChannelStatus: 'FAILED_RETRY',
        channel: 'EMAIL',
      });
      assert.equal(result.allowed, true);
      assert.equal(result.newChannelStatus, 'PERMANENT_FAILURE');
    });

    it('非重试状态 → 拒绝永久失败', () => {
      const result = sm.evaluate({
        type: 'MARK_PERMANENT_FAILURE',
        currentStatus: 'CREATED_PENDING_DELIVERY',
        currentChannelStatus: 'DELIVERED',
        channel: 'EMAIL',
      });
      assert.equal(result.allowed, false);
    });
  });

  describe('转换 10：人工补发', () => {
    it('永久失败 → 待投递（新的邮件尝试）(NTF-007)', () => {
      const result = sm.evaluate({
        type: 'MANUAL_RESEND',
        currentStatus: 'CREATED_PENDING_DELIVERY',
        currentChannelStatus: 'PERMANENT_FAILURE',
        channel: 'EMAIL',
      });
      assert.equal(result.allowed, true);
      assert.equal(result.newChannelStatus, 'PENDING');
    });

    it('非永久失败 → 拒绝人工重发', () => {
      const result = sm.evaluate({
        type: 'MANUAL_RESEND',
        currentStatus: 'CREATED_PENDING_DELIVERY',
        currentChannelStatus: 'FAILED_RETRY',
        channel: 'EMAIL',
      });
      assert.equal(result.allowed, false);
    });
  });

  describe('邮件资格评估 (NTF-004 至 NTF-007)', () => {
    // 邮件资格评估在 domain/models/channel-delivery-attempt.model.ts 中
    // 此处通过状态机验证转换 6
    it('评估邮件资格时状态机允许', () => {
      const result = sm.evaluate({
        type: 'EVALUATE_EMAIL',
        currentStatus: 'CREATED_PENDING_DELIVERY',
        currentChannelStatus: 'PENDING',
        channel: 'EMAIL',
      });
      assert.equal(result.allowed, true);
      // 邮件资格不改变通知事实主状态
      assert.equal(result.newStatus, null);
    });
  });

  describe('邮件投递成功 (NTF-006)', () => {
    it('待投递（邮件）→ 已投递（邮件）(NTF-007)', () => {
      const result = sm.evaluate({
        type: 'DELIVER_EMAIL',
        currentStatus: 'CREATED_PENDING_DELIVERY',
        currentChannelStatus: 'PENDING',
        channel: 'EMAIL',
      });
      assert.equal(result.allowed, true);
      assert.equal(result.newChannelStatus, 'DELIVERED');
    });
  });
});
