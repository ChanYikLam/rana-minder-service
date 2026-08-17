import type { ProjectionType } from '../contracts';
import type { InvalidationEvent, InvalidationEventType } from './invalidation-event';

/**
 * 失效规则：某投影类型受哪些事件类型影响。
 *
 * 由具体投影登记（子任务6 的三个投影各自声明失效面）。
 */
export interface InvalidationRule {
  readonly projectionType: ProjectionType;
  /** 受影响的失效事件类型集合 */
  readonly affectedBy: readonly InvalidationEventType[];
  /** 是否受该事件影响 */
  isAffected(event: InvalidationEvent): boolean;
}

/**
 * 基于事件类型集合的默认失效规则。
 */
export class TypeBasedInvalidationRule implements InvalidationRule {
  constructor(
    readonly projectionType: ProjectionType,
    readonly affectedBy: readonly InvalidationEventType[],
  ) {}

  isAffected(event: InvalidationEvent): boolean {
    return this.affectedBy.includes(event.type);
  }
}
