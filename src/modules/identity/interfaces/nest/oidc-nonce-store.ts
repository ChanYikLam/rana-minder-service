/**
 * OIDC 授权请求 nonce 服务端存储（interfaces/nest；CAS-CAP-004 会话固定防护）。
 *
 * 背景：仅把 nonce 编进 state 回传并不足以抵御登录 CSRF / 会话固定——攻击者可
 * 诱导受害者走完自己的 OIDC 流程，把合法 state 粘贴给受害者的回调。服务端必须
 * 记录"我确实签发过该 nonce"，回调时校验该 nonce 存在且未被复用。
 *
 * 实现：内存 Map + TTL。生产多实例部署时需替换为共享存储（如 Redis），本实现
 * 作为基线满足单实例一致性，并在创建会话后单次消费（一次性 nonce），收紧窗口。
 */

export interface OidcNonceStore {
  /** 记录一次已签发的 nonce（TTL 内有效）。 */
  issue(nonce: string, ttlMs?: number): void;
  /** 校验 nonce 是否由本服务签发且未过期；校验通过后立即消费（一次性）。 */
  consume(nonce: string): boolean;
}

/** 默认 nonce 有效期（毫秒）。与 Casdoor 授权码流程典型生命周期对齐。 */
export const DEFAULT_NONCE_TTL_MS = 10 * 60 * 1000;

interface NonceEntry {
  readonly issuedAt: number;
  readonly ttlMs: number;
}

export class InMemoryOidcNonceStore implements OidcNonceStore {
  private readonly entries = new Map<string, NonceEntry>();

  issue(nonce: string, ttlMs: number = DEFAULT_NONCE_TTL_MS): void {
    // 周期清理过期条目，避免长期堆积。
    this.prune();
    this.entries.set(nonce, { issuedAt: Date.now(), ttlMs });
  }

  consume(nonce: string): boolean {
    const entry = this.entries.get(nonce);
    if (!entry) return false;
    this.entries.delete(nonce); // 一次性 nonce
    return Date.now() - entry.issuedAt <= entry.ttlMs;
  }

  private prune(): void {
    const now = Date.now();
    for (const [nonce, entry] of this.entries) {
      if (now - entry.issuedAt > entry.ttlMs) this.entries.delete(nonce);
    }
  }
}
