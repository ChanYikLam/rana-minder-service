import { Injectable, Logger } from '@nestjs/common';
import type { InvalidationEvent } from './invalidation-event';
import type { IndexInvalidationPort } from './index-invalidation';

/**
 * 索引失效占位实现（基础设施未接入前）。
 *
 * 仅记录失效事件（可观测），不产生任何索引副作用；
 * 待 PostgreSQL 检索索引（pg_trgm/全文）落地后替换为真实实现。
 * 占位期间搜索索引"不失效"的语义：检索范围扩大不得越权——
 * 授权仍由服务端入口判定（IFC-DATA-012），索引不作为授权来源。
 */
@Injectable()
export class LogOnlyIndexInvalidation implements IndexInvalidationPort {
  private readonly logger = new Logger(LogOnlyIndexInvalidation.name);

  async invalidate(event: InvalidationEvent): Promise<void> {
    this.logger.warn(
      `索引失效：基础设施未接入（eventId=${event.eventId}, type=${event.type}, ` +
        `source=${event.source.objectType}:${event.source.objectId}@${event.source.version}）`,
    );
  }
}
