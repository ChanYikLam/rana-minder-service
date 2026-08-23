/**
 * Casdoor 运行时可用性跟踪器（interfaces/nest；CAS-FAIL-001）。
 *
 * 由会话链路（controller）在每次 Casdoor 交互后更新最近可用性观测；OidcAuth
 * SessionProvider 在解析会话时读取当前观测，决定是否收紧降级会话的 15 分钟窗口。
 *
 * 语义：
 * - 首次构建默认可用（乐观），但 provider 在拿到真实观测前不会基于降级拒绝
 *   非降级会话；只有 controller 观测到 Casdoor 不可用后置为 false，降级路径才收紧。
 * - 进程内同步读写，事件循环单线程原子，无需加锁。
 */

export class CasdoorAvailabilityTracker {
  private available = true;
  private observed = false;

  /** 记录一次 Casdoor 可用性观测。 */
  setAvailable(available: boolean): void {
    this.available = available;
    this.observed = true;
  }

  /** 最近一次观测是否可用；未观测过时按可用处理（不收紧非降级会话）。 */
  isAvailable(): boolean {
    return this.observed ? this.available : true;
  }
}
