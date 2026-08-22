/**
 * 通知查询服务（IFC-QRY-005 类、NTF-003）。
 *
 * 呈现列表（类型筛选/未读筛选/隐藏列表）、未读数、
 * 有期限通知当前办理状态与安全摘要查询。
 * 通知不是业务真相：办理状态必须从当前权威业务对象读取；
 * 已处理/已撤回为终态不被时间覆盖，其余在超过期限后显示已过期。
 */

import { Inject, Injectable } from '@nestjs/common';
import type { InboxAdapter, InboxListFilter } from '../../infrastructure';
import { resolveEffectiveDeadlineStatus } from '../../domain';
import { INBOX_ADAPTER } from '../../tokens';
import type {
  NotificationDeadlineStatus,
  NotificationItem,
  NotificationKind,
  NotificationListQuery,
} from '../../../../common/contracts/notifications.contracts';

export interface NotificationListResult {
  readonly items: NotificationItem[];
  readonly nextCursor: string | null;
}

export interface NotificationUnreadCountResult {
  readonly count: number;
}

/** 呈现子状态 → 契约状态 */
const PRESENTATION_STATUS_MAP: Record<string, NotificationItem['status']> = {
  READ: 'read',
  UNREAD: 'unread',
  PROCESSED: 'processed',
  HIDDEN: 'hidden',
};

/** 有期限办理状态 → 契约状态 */
const DEADLINE_STATUS_MAP: Record<string, NotificationDeadlineStatus> = {
  ACTIONABLE: 'actionable',
  PROCESSED: 'processed',
  WITHDRAWN: 'withdrawn',
  EXPIRED: 'expired',
};

@Injectable()
export class NotificationQueryService {
  constructor(
    @Inject(INBOX_ADAPTER)
    private readonly inboxAdapter: InboxAdapter,
  ) {}

  /**
   * 查询本人通知列表。
   * 支持类型筛选/未读筛选/隐藏列表（NTF-003）；
   * 已隐藏通知默认不展示；有期限通知显示当前办理状态。
   */
  async listForUser(
    recipientId: string,
    query: NotificationListQuery = {},
    cursor: string | null = null,
    limit: number = 20,
    now: string = new Date().toISOString(),
  ): Promise<NotificationListResult> {
    const filter: InboxListFilter = {
      kind: query.kind ?? null,
      unreadOnly: query.unreadOnly ?? false,
      includeHidden: query.includeHidden ?? false,
    };
    const items = await this.inboxAdapter.listForUser(recipientId, filter, cursor, limit);
    const notificationItems: NotificationItem[] = items.map((p) => {
      const effectiveDeadline = resolveEffectiveDeadlineStatus(p.deadlineStatus, p.deadlineAt, now);
      return {
        id: p.presentationId,
        userId: p.recipientId,
        type: p.eventType as NotificationKind,
        title: p.title,
        body: p.body,
        read: p.status === 'READ',
        status: PRESENTATION_STATUS_MAP[p.status] ?? 'unread',
        deadlineStatus: effectiveDeadline ? (DEADLINE_STATUS_MAP[effectiveDeadline] ?? null) : null,
        deadlineAt: p.deadlineAt,
        createdAt: p.deliveredAt,
        readAt: p.readAt,
        processedAt: p.processedAt,
        hiddenAt: p.hiddenAt,
        link: p.link,
        clubName: p.clubName,
      };
    });
    return {
      items: notificationItems,
      nextCursor: items.length === limit ? (items[items.length - 1]?.presentationId ?? null) : null,
    };
  }

  /**
   * 查询未读数。
   */
  async unreadCount(recipientId: string): Promise<NotificationUnreadCountResult> {
    const count = await this.inboxAdapter.countUnread(recipientId);
    return { count };
  }
}
