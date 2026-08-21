/**
 * 通知事实领域模型（NTF-001、NTF-002、IFC-TX-002）。
 *
 * 通知事实是权益业务变更的不可变记录。每条通知事实绑定一个逻辑事件、
 * 一个来源业务对象和最小摘要。正文不得复制完整报名表、内部评语、
 * 联系方式或附件。
 *
 * 通知事实与权益业务结果在同一数据库事务中原子保存（IFC-TX-002 边界 2）；
 * 通知事实保存失败则原业务整体回滚。
 */

import type { NotificationKind } from '../../../../common/contracts/notifications.contracts';

/** 通知事实主状态 */
export type NotificationFactStatus =
  'CREATED_PENDING_DELIVERY' | 'CREATED_PAUSED_DELIVERY' | 'DELIVERED';

/** 通知事实 */
export interface NotificationFactModel {
  /** 稳定标识（UUIDv7） */
  readonly factId: string;
  /** 逻辑事件标识：同一逻辑事件＋收件人去重（NTF-003） */
  readonly logicalEventId: string;
  /** 来源业务对象稳定标识 */
  readonly sourceObjectId: string;
  /** 来源业务对象版本 */
  readonly sourceObjectVersion: number;
  /** 来源业务命令 UUID（关联同一事务内各模型历史） */
  readonly sourceCommandId: string;
  /** 事件类型 */
  readonly eventType: NotificationKind;
  /** 事件时间（业务发生时间，非创建时间） */
  readonly eventTime: string;
  /** 当前主状态 */
  readonly status: NotificationFactStatus;
  /**
   * 最小摘要：只携带理解事件所需的最少信息。
   * 不得包含完整报名表、内部评语、联系方式、附件、令牌或密钥。
   */
  readonly summary: string;
  /** 当前办理对象引用（业务链接，每次打开重新鉴权） */
  readonly targetObjectRef: string | null;
  /** 有期限通知的截止时间（可选；用于站内信展示可处理/已处理/已撤回/已过期） */
  readonly deadlineAt: string | null;
  /** 作用域：社团标识或平台标识 */
  readonly scope: NotificationScope;
  /** 创建时间 */
  readonly createdAt: string;
  /** 版本号（乐观锁） */
  readonly version: number;
}

/** 通知作用域 */
export interface NotificationScope {
  readonly type: 'CLUB' | 'PLATFORM' | 'JOINT';
  readonly clubId: string | null;
}

/** 创建通知事实的输入 */
export interface CreateNotificationFactInput {
  readonly logicalEventId: string;
  readonly sourceObjectId: string;
  readonly sourceObjectVersion: number;
  readonly sourceCommandId: string;
  readonly eventType: NotificationKind;
  readonly eventTime: string;
  readonly summary: string;
  readonly targetObjectRef: string | null;
  /** 有期限通知的截止时间（可选） */
  readonly deadlineAt?: string | null;
  /**
   * 初始投递状态（可选）。
   * 站内信紧急关闭期间创建的事实标记为暂停投递（SRS-FAIL-009）；
   * 默认待投递。
   */
  readonly initialStatus?: 'CREATED_PENDING_DELIVERY' | 'CREATED_PAUSED_DELIVERY';
  readonly scope: NotificationScope;
}

/**
 * 验证通知事实创建是否合法。
 * 返回 null 表示合法，否则返回拒绝原因。
 */
export function validateNotificationFactInput(input: CreateNotificationFactInput): string | null {
  if (!input.logicalEventId) return '逻辑事件标识不能为空';
  if (!input.sourceObjectId) return '来源业务对象标识不能为空';
  if (!input.sourceCommandId) return '来源业务命令标识不能为空';
  if (!input.eventType) return '事件类型不能为空';
  if (!input.eventTime) return '事件时间不能为空';
  if (!input.summary) return '摘要不能为空';
  if (!input.scope) return '作用域不能为空';
  // 摘要不得包含敏感标记检测（简单校验）
  if (input.summary.includes('password') || input.summary.includes('token'))
    return '摘要不得包含敏感信息';
  return null;
}
