/**
 * NotificationPort → 外部通知渠道桥接（#68 / IFC-TX-002/005）。
 *
 * 组织域通知事实（关系生效/失败、预约收口等）经 ADAPTERS_NOTIFY 外部渠道
 * 附加投递：只承载投递、不成为通知事实权威；渠道失败不阻断主事务
 * （端口契约"失败不阻断主事务，但必须留痕"——此处以 console 留痕，
 * 权威落库由 notification 模块的通知事实命令承接）。
 */

import type { NotificationFact, NotificationPort } from '../application/ports';
import type { NotifyAdapter } from '../../../adapters/notify/external-notify.adapter';

export class NotifyChannelNotificationPort implements NotificationPort {
  constructor(private readonly channel: NotifyAdapter) {}

  async save(fact: NotificationFact): Promise<void> {
    for (const toUserId of fact.toUserIds) {
      try {
        const result = await this.channel.send({
          channel: 'push',
          recipient: toUserId,
          templateId: `org-${fact.kind}`,
          params: {
            title: fact.title,
            body: fact.body,
            ...(fact.clubId !== null ? { clubId: fact.clubId } : {}),
          },
          idempotencyKey: `${fact.dedupKey}:${toUserId}`,
        });
        if (result.status !== 'SUCCESS') {
          // 渠道未确认：留痕不阻断（IFC-TX-005 渠道失败不回滚权益）
          console.warn(
            `[org-notify] channel not confirmed dedupKey=${fact.dedupKey} to=${toUserId} status=${result.status}`,
          );
        }
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        console.warn(`[org-notify] dispatch failed dedupKey=${fact.dedupKey} reason=${reason}`);
      }
    }
  }
}
