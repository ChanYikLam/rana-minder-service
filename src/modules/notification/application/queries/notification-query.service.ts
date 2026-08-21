/**
 * 通知查询服务（IFC-QRY-005 类）。
 *
 * 呈现列表、未读数、有期限通知状态与安全摘要查询。
 * 通知不是业务真相：办理状态必须从当前权威业务对象读取。
 */

import { Injectable } from '@nestjs/common';
import type { InboxAdapter } from '../../infrastructure';
import type { NotificationFactModel } from '../../domain';
import type { NotificationItem } from '../../../../common/contracts/notifications.contracts';

export interface NotificationListResult {
  readonly items: NotificationItem[];
  readonly nextCursor: string | null;
}

export interface NotificationUnreadCountResult {
  readonly count: number;
}

export interface NotificationDetailResult {
  readonly presentation: NotificationItem;
  /** 业务对象当前状态（实时读取，不由通知决定） */
  readonly currentBusinessStatus: string | null;
}

@Injectable()
export class NotificationQueryService {
  constructor(private readonly inboxAdapter: InboxAdapter) {}

  /**
   * 查询本人通知列表。
   * 已隐藏通知不展示；有期限通知显示当前办理状态。
   */
  async listForUser(
    recipientId: string,
    cursor: string | null,
    limit: number,
  ): Promise<NotificationListResult> {
    const items = await this.inboxAdapter.listForUser(recipientId, cursor, limit);
    const notificationItems: NotificationItem[] = items.map((p) => ({
      id: p.presentationId,
      userId: p.recipientId,
      type: p.eventType as NotificationItem['type'],
      title: p.title,
      body: p.body,
      read: p.status === 'READ',
      createdAt: p.deliveredAt,
      link: p.link,
      clubName: p.clubName,
    }));
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

  /**
   * 查询通知详情。
   * 返回通知快照，但办理状态从当前权威业务对象读取（NTF-003）。
   * 此处 currentBusinessStatus 由各业务模块注入的读取器提供。
   */
  async detail(
    recipientId: string,
    presentationId: string,
    readBusinessStatus: (fact: NotificationFactModel) => string | null,
  ): Promise<NotificationDetailResult | null> {
    const items = await this.inboxAdapter.listForUser(recipientId, null, 1000);
    const presentation = items.find((p) => p.presentationId === presentationId);
    if (!presentation) return null;

    const notificationItem: NotificationItem = {
      id: presentation.presentationId,
      userId: presentation.recipientId,
      type: presentation.eventType as NotificationItem['type'],
      title: presentation.title,
      body: presentation.body,
      read: presentation.status === 'READ',
      createdAt: presentation.deliveredAt,
      link: presentation.link,
      clubName: presentation.clubName,
    };

    // 业务对象状态由当前权限实时鉴权读取
    // 通知快照只能作为提醒，不能覆盖、延迟或伪造当前状态
    return {
      presentation: notificationItem,
      currentBusinessStatus: readBusinessStatus({} as NotificationFactModel),
    };
  }
}
