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
  private readonly seen = new Set<string>();
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

    this.seen.add(input.rawBodyDigest);
    return { accepted: true, reason: decision.reason, envelope: decision.envelope };
  }
}
