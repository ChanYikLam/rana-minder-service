import type { RecomputeIntent } from '../contracts';

/** 重算意图登记注入令牌（RecomputeIntentSink 为接口，注入须用显式 token） */
export const RECOMPUTE_INTENT_SINK = Symbol('RECOMPUTE_INTENT_SINK');

/**
 * 重算意图登记端口。
 *
 * invalidation/领域变更把 recompute 意图提交到 job 模块的持久化任务
 * （事务发件箱，IFC-TX-008）；read-model 自身不异步写库。
 * 由 refresh 子包实现（JobRecomputeIntentSink）并注册。
 */
export interface RecomputeIntentSink {
  submit(intent: RecomputeIntent): Promise<void>;
}
