import { Inject, Injectable } from '@nestjs/common';
import type { ProjectionScope, RecomputeIntent } from '../contracts';
import { ProjectionType } from '../contracts';
import { ProjectionRegistry } from '../projection/projection-registry';
import { PROJECTION_STORE } from '../projection/projection-store';
import type { ProjectionStore } from '../projection/projection-store';
import { RECOMPUTE_INTENT_SINK } from '../refresh/recompute-intent-sink';
import type { RecomputeIntentSink } from '../refresh/recompute-intent-sink';
import { INDEX_INVALIDATION_PORT } from './index-invalidation';
import type { IndexInvalidationPort } from './index-invalidation';
import type { InvalidationEvent } from './invalidation-event';
import type { InvalidationRule } from './invalidation-rule';

/**
 * 缓存/索引失效服务（invalidation/）。
 *
 * 处理失效事件：定位受影响投影 → 标记失效（不得再返回新鲜结果）→
 * 登记重算意图（refresh 消费，经 job 持久化任务执行）。
 *
 * 不得成为授权来源：失效/重建流程不产生权限事实，不回写源业务状态
 * （IFC-DATA-012、DATA-DER-002）。
 */
@Injectable()
export class CacheInvalidationService {
  private readonly rules: InvalidationRule[] = [];

  constructor(
    private readonly registry: ProjectionRegistry,
    @Inject(PROJECTION_STORE) private readonly store: ProjectionStore,
    @Inject(RECOMPUTE_INTENT_SINK) private readonly recomputeSink: RecomputeIntentSink,
    @Inject(INDEX_INVALIDATION_PORT) private readonly indexInvalidation: IndexInvalidationPort,
  ) {}

  /** 登记失效规则（由具体投影在装配时注册） */
  registerRule(rule: InvalidationRule): void {
    this.rules.push(rule);
  }

  /**
   * 处理失效事件：标记受影响投影失效、失效搜索索引并登记重建意图。
   */
  async onInvalidation(event: InvalidationEvent): Promise<void> {
    const affectedTypes = this.rules.filter((rule) => rule.isAffected(event)).map((rule) => rule.projectionType);

    // 注册表内全部投影类型都按规则判定（防止漏失效）
    for (const projectionType of this.allProjectionTypes()) {
      if (affectedTypes.includes(projectionType)) {
        await this.store.invalidate(projectionType, event.scope, event.occurredAt, event.eventId);
      }
    }

    // 搜索索引失效（C4.2；索引不得成为授权来源，幂等以 eventId 为准）
    await this.indexInvalidation.invalidate(event);

    // 登记重建意图（旧水位不覆盖新结果由 refresh 保障）
    if (affectedTypes.length > 0) {
      await this.recomputeSink.submit({
        intentId: `inv-${event.eventId}`,
        source: event.source,
        reason: this.toRecomputeReason(event.type),
        targetProjections: affectedTypes,
        createdAt: event.occurredAt,
      });
    }
  }

  private allProjectionTypes(): readonly ProjectionType[] {
    return this.registry.list().map((builder) => builder.projectionType);
  }

  private toRecomputeReason(type: InvalidationEvent['type']): RecomputeIntent['reason'] {
    switch (type) {
      case 'PERMISSION_TIGHTENED':
        return 'SCOPE_TIGHTENED';
      case 'SOURCE_STATE_CHANGED':
        return 'SOURCE_STATE_CHANGED';
      case 'CLUB_DISABLED':
        return 'CLUB_DISABLED';
      case 'UNION_WITHDRAWN':
        return 'UNION_WITHDRAWN';
      case 'FIELD_PERMISSION_CHANGED':
        return 'FIELD_PERMISSION_CHANGED';
      case 'SOURCE_DELETED':
        return 'SOURCE_DELETED';
    }
  }
}
