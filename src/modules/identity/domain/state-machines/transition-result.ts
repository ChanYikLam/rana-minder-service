/**
 * 状态机转换结果公共类型（identity 域状态机共用）。
 *
 * 允许转换时返回 nextState（可能带副作用标记）；
 * 拒绝时返回最小可披露 reason（映射为 IFC-ERR-006 业务前置失败 / STA 分面）。
 *
 * rejectTransition 接收守卫期望状态（expected）仅作调用语义提示，结果仍只携带
 * 最小可披露 reason（预期状态不得向客户端披露，防止暴露状态机内部结构）。
 */

export type StateTransitionResult<TState extends string> =
  | { readonly allowed: true; readonly nextState: TState }
  | { readonly allowed: false; readonly reason: string };

export function allowTransition<TState extends string>(
  nextState: TState,
): StateTransitionResult<TState> {
  return { allowed: true, nextState };
}

export function rejectTransition<TState extends string>(
  expected: TState,
  reason: string,
): StateTransitionResult<TState> {
  return { allowed: false, reason };
}
