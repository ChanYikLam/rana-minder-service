/**
 * 认证端点固定窗口限流器（interfaces/nest；CAS-CAP-010 有界暴露）。
 *
 * 覆盖端点：GET /api/auth/casdoor/login-url、GET /api/auth/session（携带 code/
 * state 的会话建立路径）。无会话前置的匿名端点是唯一无需凭据即可反复触达的
 * 入口，必须限流以防：授权请求风暴放大 Casdoor 负载、code/nonce 盲猜、回调
 * 端点 DoS。
 *
 * 实现：进程内固定窗口计数（双桶：按来源 IP + 全局），不引入新依赖。
 * 已知边界：多实例部署时为"每实例"配额（全局配额 = 单实例配额 × 实例数），
 * 精确全局限流需共享存储，随 OIDC nonce 共享存储（PostgresOidcNonceStore）
 * 同一部署阶段评估；单实例基线下语义精确。
 *
 * 超限返回 429 + Retry-After，错误信封仅含安全分类码，不回显内部细节
 * （CAS-FAIL-005）。
 */

export interface RateLimitDecision {
  readonly ok: boolean;
  /** ok=false 时建议的等待秒数（向上取整，至少 1 秒）。 */
  readonly retryAfterSec: number;
}

export interface AuthRateLimiterOptions {
  /** 窗口长度毫秒（默认 60 秒）。 */
  readonly windowMs?: number;
  /** 单 key（来源 IP）窗口内允许次数（默认 10）。 */
  readonly maxPerKeyPerWindow?: number;
  /** 全局窗口内允许次数（默认 300，覆盖网关出口聚合场景）。 */
  readonly maxGlobalPerWindow?: number;
  /** 时钟注入（测试用）；默认 Date.now。 */
  readonly now?: () => number;
}

const DEFAULT_WINDOW_MS = 60_000;
const DEFAULT_MAX_PER_KEY = 10;
const DEFAULT_MAX_GLOBAL = 300;

interface WindowCounter {
  windowStart: number;
  count: number;
}

export class AuthRateLimiter {
  private readonly windowMs: number;
  private readonly maxPerKey: number;
  private readonly maxGlobal: number;
  private readonly now: () => number;
  private readonly perKey = new Map<string, WindowCounter>();
  private globalCounter: WindowCounter = { windowStart: 0, count: 0 };

  constructor(options: AuthRateLimiterOptions = {}) {
    this.windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
    this.maxPerKey = options.maxPerKeyPerWindow ?? DEFAULT_MAX_PER_KEY;
    this.maxGlobal = options.maxGlobalPerWindow ?? DEFAULT_MAX_GLOBAL;
    this.now = options.now ?? (() => Date.now());
  }

  /**
   * 记一次请求并判定是否放行。超限后本窗口内持续拒绝（计数不回退），
   * 窗口翻转后自然重置——重试风暴无法穿透窗口边界恢复配额。
   */
  check(key: string): RateLimitDecision {
    const nowMs = this.now();
    this.prune(nowMs);

    const global = this.bucket(this.globalCounter, nowMs);
    this.globalCounter = global; // 窗口翻转后回写新桶（否则全局计数永不推进）
    if (global.count >= this.maxGlobal) {
      return { ok: false, retryAfterSec: this.retryAfterSec(global.windowStart, nowMs) };
    }
    global.count += 1;

    const entry = this.perKey.get(key);
    const bucket = this.bucket(entry ?? { windowStart: nowMs, count: 0 }, nowMs);
    this.perKey.set(key, bucket);
    if (bucket.count >= this.maxPerKey) {
      return { ok: false, retryAfterSec: this.retryAfterSec(bucket.windowStart, nowMs) };
    }
    bucket.count += 1;
    return { ok: true, retryAfterSec: 0 };
  }

  private bucket(counter: WindowCounter, nowMs: number): WindowCounter {
    const windowStart = Math.floor(nowMs / this.windowMs) * this.windowMs;
    if (counter.windowStart !== windowStart) {
      return { windowStart, count: 0 };
    }
    return counter;
  }

  private retryAfterSec(windowStart: number, nowMs: number): number {
    return Math.max(1, Math.ceil((windowStart + this.windowMs - nowMs) / 1000));
  }

  private prune(nowMs: number): void {
    // 只保留当前窗口；Map 键量以来源 IP 数为上界（认证端点量级小），惰性删除足够。
    const currentWindow = Math.floor(nowMs / this.windowMs) * this.windowMs;
    for (const [key, counter] of this.perKey) {
      if (counter.windowStart < currentWindow) this.perKey.delete(key);
    }
  }
}
