/**
 * NotificationPort → 外部通知渠道桥接（#68 / IFC-TX-002/005）。
 *
 * 组织域通知事实（关系生效/失败、预约收口等）经 ADAPTERS_NOTIFY 外部渠道
 * 附加投递：只承载投递、不成为通知事实权威；渠道失败不阻断主事务
 * （端口契约"失败不阻断主事务，但必须留痕"）。
 *
 * 失败可观测性（评审：31-42）：渠道未确认/投递异常不再仅 console.warn——
 * 每次失败以结构化 NotifyDeliveryFailure 记录：
 * 1. 追加进进程内环形缓冲 deliveryFailures（上限 RING_CAPACITY，供运维
 *    查询与测试断言）；
 * 2. 若构造时注入 failureSink（部署侧接日志存储/死信表等持久化落点），
 *    同步转发留痕；sink 异常不阻断主事务（与端口契约一致）；
 * 3. 结构化日志行（NestJS Logger，字段齐全便于检索）。
 */

import { Logger } from '@nestjs/common';

import type { NotificationFact, NotificationPort } from '../application/ports';
import type { NotifyAdapter } from '../../../adapters/notify/external-notify.adapter';

/** 一次外部渠道投递失败的结构化留痕 */
export interface NotifyDeliveryFailure {
  readonly dedupKey: string;
  readonly recipient: string;
  /** 失败原因：渠道状态或脱敏后的异常摘要（不含密钥/完整响应） */
  readonly reason: string;
  readonly occurredAt: string;
}

/**
 * 失败留痕持久化落点（部署侧注入：如平台 log-storage、通知模块死信表）。
 * 返回值被吞掉、异常不外溢——留痕失败不得阻断主事务（IFC-TX-005）。
 */
export type NotifyFailureSink = (failure: NotifyDeliveryFailure) => void | Promise<void>;

/** 进程内环形缓冲上限：防长进程内存无界增长 */
const RING_CAPACITY = 500;

export class NotifyChannelNotificationPort implements NotificationPort {
  private readonly logger = new Logger(NotifyChannelNotificationPort.name);
  /** 最近投递失败记录（append-only 环形缓冲；测试/运维可读） */
  readonly deliveryFailures: NotifyDeliveryFailure[] = [];

  constructor(
    private readonly channel: NotifyAdapter,
    private readonly failureSink?: NotifyFailureSink,
  ) {}

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
          await this.recordFailure({
            dedupKey: fact.dedupKey,
            recipient: toUserId,
            reason: `status=${result.status}`,
            occurredAt: new Date().toISOString(),
          });
        }
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        await this.recordFailure({
          dedupKey: fact.dedupKey,
          recipient: toUserId,
          reason,
          occurredAt: new Date().toISOString(),
        });
      }
    }
  }

  /** 结构化失败留痕：环形缓冲 + 可选持久化 sink + 结构化日志行 */
  private async recordFailure(failure: NotifyDeliveryFailure): Promise<void> {
    this.deliveryFailures.push(failure);
    if (this.deliveryFailures.length > RING_CAPACITY) {
      this.deliveryFailures.shift();
    }
    try {
      await this.failureSink?.(failure);
    } catch (sinkErr) {
      // sink 失败仅降级为日志，不外溢（留痕失败同样不阻断主事务）
      this.logger.warn(
        `[org-notify] failure sink rejected dedupKey=${failure.dedupKey} ` +
          `reason=${sinkErr instanceof Error ? sinkErr.message : String(sinkErr)}`,
      );
    }
    this.logger.warn(
      `[org-notify] delivery failed dedupKey=${failure.dedupKey} ` +
        `to=${failure.recipient} reason=${failure.reason} at=${failure.occurredAt}`,
    );
  }
}
