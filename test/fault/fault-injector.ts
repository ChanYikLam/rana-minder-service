/**
 * FaultInjector：L4 故障注入通用助手（TST-FAIL-* 锚点的行为级验证）。
 *
 * 三步模式：注入故障 → 验证失败关闭 → 移除故障并验证恢复。
 * 支持两种模式：
 * - persistent：持续故障直到手动 clearFault()；
 * - failOnce：首次调用故障后自动恢复（模拟瞬时超时）。
 */

export interface FaultTarget {
  readonly clearFault: () => void;
  readonly callCount: () => number;
  readonly isFaulted: () => boolean;
}

/**
 * 将任意 async 函数包装为可注入故障的代理。
 *
 * @param original 原始实现
 * @param error 故障时抛出的错误
 * @param mode 'persistent'（默认）= 持续故障直到 clearFault；'failOnce' = 首次调用后自动恢复
 */
export function injectFault<T extends (...args: never[]) => Promise<unknown>>(
  original: T,
  error: Error,
  mode: 'failOnce' | 'persistent' = 'persistent',
): T & FaultTarget {
  let calls = 0;
  let faulted = true;
  const wrapped = async (...args: Parameters<T>): Promise<unknown> => {
    calls += 1;
    if (faulted) {
      if (mode === 'failOnce') {
        faulted = false;
      }
      throw error;
    }
    return original(...args);
  };
  return Object.assign(wrapped, {
    clearFault() {
      faulted = false;
    },
    isFaulted: () => faulted,
    callCount: () => calls,
  }) as never;
}
