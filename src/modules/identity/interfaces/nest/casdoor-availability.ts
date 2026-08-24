/**
 * Casdoor 连通状态（interfaces/nest；CAS-FAIL-001 降级窗口）。
 *
 * 降级窗口依赖"上一轮 Casdoor 连通探测结果"。该状态必须在模块装配
 * （OidcAuthSessionProvider 读取）与会话控制器（Casdoor 操作失败时标记）之间
 * 共享，且允许运行时动态变化——否则 casdoorAvailable 恒为 true，CAS-FAIL-001
 * 的 15 分钟降级逻辑永不生效。
 *
 * 语义：
 * - available=true  ：最近一轮 Casdoor 探测正常，degraded 会话无时间窗限制；
 * - available=false ：Casdoor 不可达，degraded 会话仅签发后 15 分钟内有效。
 *   初始值按配置存在（controller 可签发）视为 available=true，由控制器在真实
 *   调用失败后下调为 false。
 */

export class CasdoorAvailability {
  private _available: boolean;

  constructor(initial = true) {
    this._available = initial;
  }

  get available(): boolean {
    return this._available;
  }

  /** Casdoor 连通探测失败时下调为不可用（降级窗口收紧）。 */
  markUnavailable(): void {
    this._available = false;
  }

  /** 探测恢复后上调为可用（降级窗口放行）。 */
  markAvailable(): void {
    this._available = true;
  }
}
