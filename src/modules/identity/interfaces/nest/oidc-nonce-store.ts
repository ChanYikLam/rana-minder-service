/**
 * OIDC 授权请求 nonce 服务端存储（interfaces/nest；CAS-CAP-004 会话固定防护）。
 *
 * 背景：仅把 nonce 编进 state 回传并不足以抵御登录 CSRF / 会话固定——攻击者可
 * 诱导受害者走完自己的 OIDC 流程，把合法 state 粘贴给受害者的回调。服务端必须
 * 记录"我确实签发过该 nonce"，回调时校验该 nonce 存在且未被复用。
 *
 * PKCE（S256）承载：签发授权请求时同时生成 code_verifier，与 nonce 绑定存入
 * 本存储（载荷）；回调换码时一次性取出并附到 token 请求。verifier 绝不出现在
 * 授权 URL/state/Cookie 等任何经浏览器的通道（RFC 7636：仅服务端持有）。
 *
 * 实现：内存 Map + TTL（单实例基线）。多实例/重启安全部署使用
 * PostgresOidcNonceStore（infrastructure/postgres-oidc-nonce.store.ts），经
 * OIDC_NONCE_STORE 注入位替换，本实现接口保持一致。
 */

export interface OidcNonceStore {
  /**
   * 记录一次已签发的 nonce（TTL 内有效）。共享存储实现（Postgres）为异步，
   * 调用方必须 await 完成后再下发授权 URL，避免回调先于落库到达。
   * @param payload 可选服务端私有载荷（如 PKCE code_verifier）；仅存服务端，
   *                回调时经 consume 原样取回。
   */
  issue(nonce: string, ttlMs?: number, payload?: string): void | Promise<void>;
  /**
   * 校验 nonce 是否由本服务签发且未过期；校验通过后立即消费（一次性）。
   * @returns 签发时绑定的载荷（未携带载荷时为空串）；nonce 无效/过期/已消费
   *          返回 null。一次性消费与载荷取回是同一原子操作，不可拆分重放。
   *          共享存储实现为异步，调用方必须 await。
   */
  consume(nonce: string): string | null | Promise<string | null>;
}

/** 默认 nonce 有效期（毫秒）。与 Casdoor 授权码流程典型生命周期对齐。 */
export const DEFAULT_NONCE_TTL_MS = 10 * 60 * 1000;

interface NonceEntry {
  readonly issuedAt: number;
  readonly ttlMs: number;
  /** 服务端私有载荷（PKCE code_verifier 等）；不出现在任何经浏览器通道。 */
  readonly payload: string;
}

export class InMemoryOidcNonceStore implements OidcNonceStore {
  private readonly entries = new Map<string, NonceEntry>();

  issue(nonce: string, ttlMs: number = DEFAULT_NONCE_TTL_MS, payload: string = ''): void {
    // 周期清理过期条目，避免长期堆积。
    this.prune();
    this.entries.set(nonce, { issuedAt: Date.now(), ttlMs, payload });
  }

  consume(nonce: string): string | null {
    const entry = this.entries.get(nonce);
    if (!entry) return null;
    this.entries.delete(nonce); // 一次性 nonce
    if (Date.now() - entry.issuedAt > entry.ttlMs) return null;
    return entry.payload;
  }

  private prune(): void {
    const now = Date.now();
    for (const [nonce, entry] of this.entries) {
      if (now - entry.issuedAt > entry.ttlMs) this.entries.delete(nonce);
    }
  }
}
