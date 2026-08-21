/**
 * 通知状态机（SRS-SM-NTF-001）。
 *
 * 通知事实、站内信投递、邮件投递和用户已读/已处理/隐藏
 * 是同一逻辑事件的正交维度；已读状态不得改变业务对象状态。
 *
 * 转换规则（10 条）：
 * 1. 新建 → 已创建＋待投递 / 已创建＋暂停投递（权益业务命令创建通知事实）
 * 2. 已创建＋待投递 → 已创建＋暂停投递（超级管理员紧急关闭站内信）
 * 3. 已创建＋暂停投递 → 待投递（站内信服务恢复）
 * 4. 已创建＋待投递 → 已投递（系统站内信任务投递）
 * 5. 已投递 → 已读/已处理/隐藏（收件人标记）
 * 6. 已创建 → 待投递（邮件子状态）/ 状态不变（评估邮件资格）
 * 7. 待投递（邮件）→ 已投递（邮件）（邮件发送成功）
 * 8. 待投递/失败重试 → 失败重试（临时投递失败）
 * 9. 失败重试 → 永久失败（明确退信或连续失败 24 小时）
 * 10. 永久失败 → 待投递（新的邮件尝试）（人工重发）
 */

import type {
  ChannelDeliveryStatus,
  ChannelType,
  InboxPresentationStatus,
  NotificationFactStatus,
} from '../models';

/** 状态机转换结果 */
export interface TransitionResult {
  readonly allowed: boolean;
  readonly newStatus: NotificationFactStatus | null;
  readonly newChannelStatus: ChannelDeliveryStatus | null;
  readonly newPresentationStatus: InboxPresentationStatus | null;
  readonly reason: string | null;
}

/** 状态转换命令 */
export interface StateTransitionCommand {
  /** 转换类型 */
  readonly type: TransitionType;
  /** 当前通知事实状态 */
  readonly currentStatus: NotificationFactStatus;
  /** 当前渠道状态（可选） */
  readonly currentChannelStatus?: ChannelDeliveryStatus;
  /** 当前呈现状态（可选） */
  readonly currentPresentationStatus?: InboxPresentationStatus;
  /** 站内信是否被紧急关闭 */
  readonly inboxKilled?: boolean;
  /** 渠道类型 */
  readonly channel?: ChannelType;
}

/** 转换类型 */
export type TransitionType =
  | 'CREATE_NOTIFICATION_FACT'
  | 'KILL_INBOX'
  | 'RESUME_INBOX'
  | 'DELIVER_INBOX'
  | 'MARK_READ'
  | 'MARK_ALL_READ'
  | 'MARK_PROCESSED'
  | 'MARK_HIDDEN'
  | 'EVALUATE_EMAIL'
  | 'DELIVER_EMAIL'
  | 'RETRY_FAILURE'
  | 'MARK_PERMANENT_FAILURE'
  | 'MANUAL_RESEND';

export class NotificationStateMachine {
  /**
   * 评估状态转换是否合法。
   */
  evaluate(command: StateTransitionCommand): TransitionResult {
    switch (command.type) {
      case 'CREATE_NOTIFICATION_FACT':
        return this.evaluateCreateNotificationFact(command);
      case 'KILL_INBOX':
        return this.evaluateKillInbox(command);
      case 'RESUME_INBOX':
        return this.evaluateResumeInbox(command);
      case 'DELIVER_INBOX':
        return this.evaluateDeliverInbox(command);
      case 'MARK_READ':
        return this.evaluateMarkRead(command);
      case 'MARK_ALL_READ':
        return this.evaluateMarkAllRead(command);
      case 'MARK_PROCESSED':
        return this.evaluateMarkProcessed(command);
      case 'MARK_HIDDEN':
        return this.evaluateMarkHidden(command);
      case 'EVALUATE_EMAIL':
        return this.evaluateEmailEligibility(command);
      case 'DELIVER_EMAIL':
        return this.evaluateDeliverEmail(command);
      case 'RETRY_FAILURE':
        return this.evaluateRetryFailure(command);
      case 'MARK_PERMANENT_FAILURE':
        return this.evaluateMarkPermanentFailure(command);
      case 'MANUAL_RESEND':
        return this.evaluateManualResend(command);
      default:
        return {
          allowed: false,
          newStatus: null,
          newChannelStatus: null,
          newPresentationStatus: null,
          reason: '未知转换类型',
        };
    }
  }

  /**
   * 转换 1：权益业务命令创建通知事实。
   * 新建 → 已创建＋待投递 / 已创建＋暂停投递
   */
  private evaluateCreateNotificationFact(command: StateTransitionCommand): TransitionResult {
    if (command.currentStatus !== ('NEW' as NotificationFactStatus)) {
      return this.reject('通知事实已存在，不可重复创建');
    }
    const newStatus = command.inboxKilled ? 'CREATED_PAUSED_DELIVERY' : 'CREATED_PENDING_DELIVERY';
    return {
      allowed: true,
      newStatus: newStatus as NotificationFactStatus,
      newChannelStatus: null,
      newPresentationStatus: null,
      reason: null,
    };
  }

  /**
   * 转换 2：超级管理员紧急关闭站内信。
   * 已创建＋待投递/失败重试 → 已创建＋暂停投递
   */
  private evaluateKillInbox(command: StateTransitionCommand): TransitionResult {
    if (
      command.currentStatus === 'CREATED_PENDING_DELIVERY' ||
      command.currentChannelStatus === 'FAILED_RETRY'
    ) {
      return {
        allowed: true,
        newStatus: 'CREATED_PAUSED_DELIVERY',
        newChannelStatus: null,
        newPresentationStatus: null,
        reason: null,
      };
    }
    if (command.currentStatus === 'DELIVERED') {
      return this.reject('已投递的通知不可暂停');
    }
    return this.reject('当前状态不允许暂停');
  }

  /**
   * 转换 3：站内信服务恢复。
   * 已创建＋暂停投递 → 待投递
   */
  private evaluateResumeInbox(command: StateTransitionCommand): TransitionResult {
    if (command.currentStatus === 'CREATED_PAUSED_DELIVERY') {
      return {
        allowed: true,
        newStatus: 'CREATED_PENDING_DELIVERY',
        newChannelStatus: null,
        newPresentationStatus: null,
        reason: null,
      };
    }
    return this.reject('当前状态不是暂停投递，无法恢复');
  }

  /**
   * 转换 4：系统站内信任务投递。
   * 已创建＋待投递 → 已投递
   */
  private evaluateDeliverInbox(command: StateTransitionCommand): TransitionResult {
    if (command.currentStatus === 'CREATED_PENDING_DELIVERY') {
      return {
        allowed: true,
        newStatus: 'DELIVERED',
        newChannelStatus: 'DELIVERED',
        newPresentationStatus: 'UNREAD',
        reason: null,
      };
    }
    if (command.currentStatus === 'CREATED_PAUSED_DELIVERY') {
      return this.reject('站内信已暂停投递');
    }
    if (command.currentStatus === 'DELIVERED') {
      return {
        allowed: true,
        newStatus: 'DELIVERED',
        newChannelStatus: 'DELIVERED',
        newPresentationStatus: null,
        reason: null,
      };
    }
    return this.reject('当前状态不允许投递');
  }

  /**
   * 转换 5a：收件人标记已读（幂等：已读状态重复标记不拒绝）。
   * 已投递 → 已读
   */
  private evaluateMarkRead(command: StateTransitionCommand): TransitionResult {
    if (command.currentStatus !== 'DELIVERED') {
      return this.reject('通知尚未投递，不能标记已读');
    }
    return {
      allowed: true,
      newStatus: 'DELIVERED',
      newChannelStatus: null,
      newPresentationStatus: 'READ',
      reason: null,
    };
  }

  /**
   * 转换 5b：全部已读。
   */
  private evaluateMarkAllRead(_command: StateTransitionCommand): TransitionResult {
    return {
      allowed: true,
      newStatus: null,
      newChannelStatus: null,
      newPresentationStatus: 'READ',
      reason: null,
    };
  }

  /**
   * 转换 5c：收件人标记已处理（幂等：已处理状态重复标记不拒绝）。
   * 已投递 → 已处理
   */
  private evaluateMarkProcessed(command: StateTransitionCommand): TransitionResult {
    if (command.currentStatus !== 'DELIVERED') {
      return this.reject('通知尚未投递，不能标记已处理');
    }
    return {
      allowed: true,
      newStatus: 'DELIVERED',
      newChannelStatus: null,
      newPresentationStatus: 'PROCESSED',
      reason: null,
    };
  }

  /**
   * 转换 5d：收件人隐藏。
   * 已投递 → 隐藏
   */
  private evaluateMarkHidden(command: StateTransitionCommand): TransitionResult {
    if (command.currentStatus !== 'DELIVERED') {
      return this.reject('通知尚未投递，不能隐藏');
    }
    return {
      allowed: true,
      newStatus: 'DELIVERED',
      newChannelStatus: null,
      newPresentationStatus: 'HIDDEN',
      reason: null,
    };
  }

  /**
   * 转换 6：评估邮件资格。
   * 已创建 → 待投递（邮件子状态）/ 状态不变
   */
  private evaluateEmailEligibility(command: StateTransitionCommand): TransitionResult {
    // 邮件资格评估不改变通知事实主状态
    return {
      allowed: true,
      newStatus: null,
      newChannelStatus: command.channel === 'EMAIL' ? 'PENDING' : null,
      newPresentationStatus: null,
      reason: null,
    };
  }

  /**
   * 转换 7：邮件发送成功。
   * 待投递（邮件）→ 已投递（邮件）
   */
  private evaluateDeliverEmail(command: StateTransitionCommand): TransitionResult {
    if (
      command.currentChannelStatus === 'PENDING' ||
      command.currentChannelStatus === 'FAILED_RETRY'
    ) {
      return {
        allowed: true,
        newStatus: null,
        newChannelStatus: 'DELIVERED',
        newPresentationStatus: null,
        reason: null,
      };
    }
    return this.reject('当前邮件状态不允许投递');
  }

  /**
   * 转换 8：临时投递失败。
   * 待投递/失败重试 → 失败重试
   */
  private evaluateRetryFailure(command: StateTransitionCommand): TransitionResult {
    if (
      command.currentChannelStatus === 'PENDING' ||
      command.currentChannelStatus === 'FAILED_RETRY'
    ) {
      return {
        allowed: true,
        newStatus: null,
        newChannelStatus: 'FAILED_RETRY',
        newPresentationStatus: null,
        reason: null,
      };
    }
    return this.reject('当前渠道状态不允许重试');
  }

  /**
   * 转换 9：明确退信或连续失败 24 小时。
   * 失败重试 → 永久失败
   */
  private evaluateMarkPermanentFailure(command: StateTransitionCommand): TransitionResult {
    if (command.currentChannelStatus === 'FAILED_RETRY') {
      return {
        allowed: true,
        newStatus: null,
        newChannelStatus: 'PERMANENT_FAILURE',
        newPresentationStatus: null,
        reason: null,
      };
    }
    return this.reject('只有重试中状态可进入永久失败');
  }

  /**
   * 转换 10：人工重发。
   * 永久失败 → 待投递（新的邮件尝试）
   */
  private evaluateManualResend(command: StateTransitionCommand): TransitionResult {
    if (command.currentChannelStatus === 'PERMANENT_FAILURE') {
      return {
        allowed: true,
        newStatus: null,
        newChannelStatus: 'PENDING',
        newPresentationStatus: null,
        reason: null,
      };
    }
    return this.reject('只有永久失败状态可人工重发');
  }

  private reject(reason: string): TransitionResult {
    return {
      allowed: false,
      newStatus: null,
      newChannelStatus: null,
      newPresentationStatus: null,
      reason,
    };
  }
}
