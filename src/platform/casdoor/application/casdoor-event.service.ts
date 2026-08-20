/**
 * Casdoor Webhook 收件服务（CAS-EVT-001~007）。
 *
 * 默认关闭；启用时仅作为非权威刷新提示，不直接改变业务状态/关系/权限。
 */

import { Injectable } from '@nestjs/common';

import {
  decideWebhookHandling,
  WEBHOOK_DEFAULT_ENABLED,
  type WebhookEnvelope,
} from '../domain/webhook-policy';

export interface WebhookHandleResult {
  readonly accepted: boolean;
  readonly reason: string;
  readonly envelope: WebhookEnvelope | null;
}

@Injectable()
export class CasdoorEventService {
  /** 去重窗口：超过该时长的摘要不再视为重复。 */
  static readonly DEDUP_TTL_MS = 5 * 60 * 1000;
  /** 去重集合上限：防止 Webhook 洪泛导致内存无限增长。 */
  static readonly DEDUP_MAX_ENTRIES = 10_000;

  private readonly seen = new Map<string, number>();
  private readonly enabled: boolean;
  private readonly staticSecret: string | null;

  constructor(options: { enabled?: boolean; staticSecret?: string | null } = {}) {
    this.enabled = options.enabled ?? WEBHOOK_DEFAULT_ENABLED;
    this.staticSecret = options.staticSecret ?? null;
  }

  async handleWebhook(input: {
    readonly receivedAt: string;
    readonly localEventId: string;
    readonly objectType: WebhookEnvelope['objectType'];
    readonly objectRef: string;
    readonly rawBodyDigest: string;
    readonly secretHeader?: string;
    readonly rateLimitAvailable: boolean;
  }): Promise<WebhookHandleResult> {
    const receivedMs = Date.parse(input.receivedAt);
    this.prune(receivedMs);

    const decision = decideWebhookHandling({
      enabled: this.enabled,
      staticSecretConfigured: this.staticSecret !== null,
      secretHeaderMatches: this.staticSecret !== null && input.secretHeader === this.staticSecret,
      rateLimitAvailable: input.rateLimitAvailable,
      dedupSeen: this.seen.has(input.rawBodyDigest),
      receivedAt: input.receivedAt,
      localEventId: input.localEventId,
      objectType: input.objectType,
      objectRef: input.objectRef,
      rawBodyDigest: input.rawBodyDigest,
    });

    if (!decision.allowed || decision.envelope === null) {
      return { accepted: false, reason: decision.reason, envelope: null };
    }

    this.seen.set(input.rawBodyDigest, receivedMs);
    return { accepted: true, reason: decision.reason, envelope: decision.envelope };
  }

  /** 清理过期摘要；若仍超过上限则淘汰最旧条目，保证内存有界。 */
  private prune(nowMs: number): void {
    const ttlMs = CasdoorEventService.DEDUP_TTL_MS;
    for (const [digest, at] of this.seen) {
      if (nowMs - at > ttlMs) this.seen.delete(digest);
    }
    if (this.seen.size > CasdoorEventService.DEDUP_MAX_ENTRIES) {
      const overflow = this.seen.size - CasdoorEventService.DEDUP_MAX_ENTRIES;
      const sorted = [...this.seen.entries()].sort((a, b) => a[1] - b[1]);
      for (let i = 0; i < overflow; i++) this.seen.delete(sorted[i][0]);
    }
  }
}
