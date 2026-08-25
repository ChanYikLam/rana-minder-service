/**
 * FaultInjector：L4 故障注入通用助手（TST-FAIL-* 锚点的行为级验证）。
 *
 * 三步模式：注入故障 → 验证失败关闭 → 移除故障并验证恢复。
 * 支持一次性故障（failNextCall）、持续故障、N 次后恢复。
 */

export interface FaultTarget {
  /** 调用计数 */
  readonly callCount: () => number;
  /** 是否处于故障状态 */
  readonly isFaulted: () => boolean;
}

/**
 * 将任意 async 函数包装为可注入故障的代理。
 *
 * @param original 原始实现
 * @param error 故障时抛出的错误
 * @param mode failOnce = 仅首次调用故障后自动恢复；persistent = 持续故障直到 clearFault
 */
export function injectFault<T extends (...args: never[]) => Promise<unknown>>(
  original: T,
  error: Error,
  mode: 'failOnce' | 'persistent' = 'persistent',
): T & { clearFault(): void; isFaulted(): boolean; callCount(): number } {
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
