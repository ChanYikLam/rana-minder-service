/**
 * Casdoor Webhook 收件服务（CAS-EVT-001~007）。
 *
 * 默认关闭；启用时仅作为非权威刷新提示，不直接改变业务状态/关系/权限。
 */

import { Inject, Injectable, Optional } from '@nestjs/common';
import { timingSafeEqual } from 'node:crypto';

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

export const CASDOOR_WEBHOOK_ENABLED = Symbol('CASDOOR_WEBHOOK_ENABLED');
export const CASDOOR_WEBHOOK_STATIC_SECRET = Symbol('CASDOOR_WEBHOOK_STATIC_SECRET');
export const CASDOOR_WEBHOOK_MAX_SEEN_ENTRIES = Symbol('CASDOOR_WEBHOOK_MAX_SEEN_ENTRIES');

const DEFAULT_MAX_SEEN_ENTRIES = 10_000;

@Injectable()
export class CasdoorEventService {
  private readonly seen = new Set<string>();
  private readonly seenOrder: string[] = [];
  private readonly maxSeenEntries: number;
  private readonly enabled: boolean;
  private readonly staticSecret: string | null;

  constructor(
    @Optional()
    @Inject(CASDOOR_WEBHOOK_ENABLED)
    enabled?: boolean,
    @Optional()
    @Inject(CASDOOR_WEBHOOK_STATIC_SECRET)
    staticSecret?: string | null,
    @Optional()
    @Inject(CASDOOR_WEBHOOK_MAX_SEEN_ENTRIES)
    maxSeenEntries?: number,
  ) {
    this.enabled = enabled ?? WEBHOOK_DEFAULT_ENABLED;
    this.staticSecret = staticSecret ?? null;
    this.maxSeenEntries = maxSeenEntries ?? DEFAULT_MAX_SEEN_ENTRIES;
  }

  /** 有界去重：容量超限时淘汰最早记录，防止长期运行内存无界增长。 */
  private remember(digest: string): void {
    if (this.seen.has(digest)) return;
    this.seen.add(digest);
    this.seenOrder.push(digest);
    if (this.seenOrder.length > this.maxSeenEntries) {
      const oldest = this.seenOrder.shift();
      if (oldest !== undefined) this.seen.delete(oldest);
    }
  }

  /** 常量时间比较静态秘密，避免时间侧信道（CAS-EVT-002）。 */
  private secretMatches(input: string | undefined): boolean {
    if (this.staticSecret === null || input === undefined) return false;
    const expected = Buffer.from(this.staticSecret);
    const actual = Buffer.from(input);
    if (expected.length !== actual.length) return false;
    return timingSafeEqual(expected, actual);
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
    const decision = decideWebhookHandling({
      enabled: this.enabled,
      staticSecretConfigured: this.staticSecret !== null,
      secretHeaderMatches: this.secretMatches(input.secretHeader),
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

    this.remember(input.rawBodyDigest);
    return { accepted: true, reason: decision.reason, envelope: decision.envelope };
  }
}
