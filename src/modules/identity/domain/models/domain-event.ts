/**
 * 领域事件基座（identity 域）。
 *
 * 不可变；由聚合根在每次状态变更时发出，供应用层登记审计/通知/任务意图
 * （分层实现规范 §3：可变聚合根在每次状态变更时同步发出领域事件）。
 */

export type DomainEvent<TName extends string, TPayload> = {
  readonly type: TName;
  readonly occurredAt: Date;
  readonly payload: TPayload;
};
