import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { FileAccessAction } from '../domain/services/access-policy';

/** 短时地址提供者注入令牌（SignedUrlProvider 为接口，注入须用显式 token） */
export const SIGNED_URL_PROVIDER = Symbol('SIGNED_URL_PROVIDER');

/** 短时访问能力（IFC-FIL-005：不提供永久公开链接；只生成短时、最小范围地址） */
export interface ShortLivedAccess {
  /** 一次性访问令牌（不成为长期授权事实） */
  readonly token: string;
  readonly fileId: string;
  readonly action: FileAccessAction;
  /** 到期时间（短时；到期后拒绝） */
  readonly expiresAt: string;
  /** 水印内容（敏感附件；可空） */
  readonly watermarkContent?: string;
}

/**
 * 短时地址提供者端口。
 *
 * 只保存最小生成/失效证据，不成为长期授权事实（DATA-FIL-003）；
 * 旧链接不缓存授权：每次访问仍须实时鉴权（FORM-008）。
 */
export interface SignedUrlProvider {
  issue(
    fileId: string,
    action: FileAccessAction,
    opts?: { ttlMs?: number; watermarkContent?: string },
  ): Promise<ShortLivedAccess>;
  /** 校验并消费一次性访问令牌（到期/已用/未知均拒绝） */
  verify(token: string): Promise<TokenVerification>;
}

/** 一次性令牌校验结果 */
export interface TokenVerification {
  readonly valid: boolean;
  /** 无效原因（仅 valid=false 时有值） */
  readonly reason?: 'EXPIRED' | 'USED' | 'UNKNOWN';
  /** 通过校验时返回关联的访问能力（供消费侧读取最小范围信息） */
  readonly access?: ShortLivedAccess;
}

/**
 * 默认短时地址提供者：令牌短时有效，默认 5 分钟。
 *
 * 通过**内存状态关联**严格兑现“短时失效”（到期即拒）与“一次性语义”（消费后作废）
 * 承诺（IFC-FIL-005）：签发时记录 token 状态，`verify` 在到期后或已被消费时拒绝。
 * 当前实现为进程内内存 Map，仅适合单实例/开发环境；正式环境应替换为 Redis 等共享
 * 存储并设置对应 TTL，以支持多实例一致性。
 *
 * ⚠️ 一次性消费语义的生产适配须知（评审 warning）：当前内存 Map 为单线程无竞态；
 * 若改用 Redis 等共享存储，`verify` 的「读取 → 判状态 → 置已消费」三步必须用**原子操作**
 * 实现（如 `SET NX PX` 签发 + Lua 脚本 / `GETDEL` 消费），否则多实例并发消费同一令牌会
 * 产生 TOCTOU 竞态，导致一次性令牌可被重复使用（越权）。
 */
@Injectable()
export class DefaultSignedUrlProvider implements SignedUrlProvider {
  static readonly DEFAULT_TTL_MS = 5 * 60_000;
  /** 短时地址最大有效期（避免误传大值破坏“短时地址”承诺） */
  static readonly MAX_TTL_MS = 30 * 60_000;

  /** token -> 状态（到期时间 + 是否已消费），仅保留在途短时令牌 */
  private readonly store = new Map<
    string,
    { expiresAt: number; consumed: boolean; access: ShortLivedAccess }
  >();

  /** 距上次全量清理的最小间隔，避免高频签发时每次都 O(n) 遍历（评审建议） */
  private static readonly PRUNE_INTERVAL_MS = 30_000;

  /** 上次执行全量清理的时间戳（惰性/节流清理用） */
  private lastPrunedAt = 0;

  async issue(
    fileId: string,
    action: FileAccessAction,
    opts?: { ttlMs?: number; watermarkContent?: string },
  ): Promise<ShortLivedAccess> {
    // 惰性/节流清理：距上次清理超过间隔才执行一次 O(n) 遍历，高频签发不再每次全量扫描
    // （过期但从未被 verify 的残留令牌最迟在 PRUNE_INTERVAL_MS 后清理，内存仍可收敛）
    const now = Date.now();
    if (now - this.lastPrunedAt >= DefaultSignedUrlProvider.PRUNE_INTERVAL_MS) {
      this.pruneExpired();
      this.lastPrunedAt = now;
    }
    // TTL 做上限约束：默认 5 分钟，超过最大有效期则截断为最大有效期；
    // 用 Number.isFinite 兜底非有限值（NaN/±Infinity），否则 new Date(NaN).toISOString() 会抛 RangeError 崩溃
    const requested = opts?.ttlMs ?? DefaultSignedUrlProvider.DEFAULT_TTL_MS;
    const ttl = Number.isFinite(requested)
      ? Math.min(Math.max(0, requested), DefaultSignedUrlProvider.MAX_TTL_MS)
      : DefaultSignedUrlProvider.DEFAULT_TTL_MS;
    const access: ShortLivedAccess = {
      token: randomUUID(),
      fileId,
      action,
      expiresAt: new Date(Date.now() + ttl).toISOString(),
      watermarkContent: opts?.watermarkContent,
    };
    // 记录状态关联（一次性 + 到期）；服务端入口/生产适配可据此校验与作废
    this.store.set(access.token, {
      expiresAt: Date.now() + ttl,
      consumed: false,
      access,
    });
    return access;
  }

  async verify(token: string): Promise<TokenVerification> {
    const state = this.store.get(token);
    if (!state) {
      return { valid: false, reason: 'UNKNOWN' };
    }
    if (state.consumed) {
      // 已消费令牌：立即删除状态，避免已消费令牌永久滞留内存（评审 warning）；
      // 仍保留 USED 语义，让重复消费可被识别（而非误判为未知令牌）
      this.store.delete(token);
      return { valid: false, reason: 'USED' };
    }
    if (Date.now() > state.expiresAt) {
      // 过期即作废，清理状态，避免内存累积
      this.store.delete(token);
      return { valid: false, reason: 'EXPIRED' };
    }
    // 一次性语义：消费后置为已消费（下轮清理时一并回收）；同时立即作废
    state.consumed = true;
    return { valid: true, access: state.access };
  }

  /**
   * 清理不再有用的令牌状态，避免短时地址永久滞留内存：
   * - 已过期且未被消费的残留令牌（用户拿到短时地址但从未点击）；
   * - 已被消费的令牌（一次性语义已用尽，无论是否过期均无保留价值）。
   * 在每次 `issue` 签发时顺带执行，开销为一次 O(n) 遍历，令牌总量有 TTL 上限兜底。
   */
  private pruneExpired(): void {
    const now = Date.now();
    for (const [token, state] of this.store) {
      if (state.consumed || now > state.expiresAt) {
        this.store.delete(token);
      }
    }
  }
}
