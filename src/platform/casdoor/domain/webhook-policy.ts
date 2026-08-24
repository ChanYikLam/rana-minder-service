/**
 * Webhook 默认关闭策略（CAS-EVT-001~007）。
 *
 * v3.108.0 不提供可验证逐消息签名/时间戳/nonce/稳定事件 ID，因此 Webhook
 * 只能作为非权威刷新提示；默认关闭。即使启用也必须通过静态秘密、限流和
 * 本地去重后才允许触发受限定向读回。
 */

export const WEBHOOK_DEFAULT_ENABLED = false;

export interface WebhookEnvelope {
  readonly receivedAt: string;
  readonly localEventId: string;
  readonly objectType: 'USER' | 'GROUP' | 'ORGANIZATION' | 'UNKNOWN';
  readonly objectRef: string;
  readonly dedupDigest: string;
  readonly allowed: boolean;
  readonly reason: string;
}

export interface WebhookDecisionInput {
  readonly enabled: boolean;
  readonly staticSecretConfigured: boolean;
  readonly secretHeaderMatches: boolean;
  readonly rateLimitAvailable: boolean;
  readonly dedupSeen: boolean;
  readonly receivedAt: string;
  readonly localEventId: string;
  readonly objectType: WebhookEnvelope['objectType'];
  readonly objectRef: string;
  readonly rawBodyDigest: string;
}

export function decideWebhookHandling(input: WebhookDecisionInput): {
  readonly allowed: boolean;
  readonly reason: string;
  readonly envelope: WebhookEnvelope | null;
} {
  if (!input.enabled) {
    return { allowed: false, reason: 'CAS-EVT-001: Webhook 默认关闭', envelope: null };
  }
  if (!input.staticSecretConfigured || !input.secretHeaderMatches) {
    return { allowed: false, reason: 'CAS-EVT-002: 静态秘密未配置或不匹配', envelope: null };
  }
  if (!input.rateLimitAvailable) {
    return { allowed: false, reason: 'CAS-EVT-002: 缺少限流保护', envelope: null };
  }
  if (input.dedupSeen) {
    return {
      allowed: false,
      reason: 'CAS-EVT-004: 重复事件已去重，不重复触发',
      envelope: null,
    };
  }

  return {
    allowed: true,
    reason: '仅触发非权威刷新提示，不直接改变业务状态',
    envelope: {
      receivedAt: input.receivedAt,
      localEventId: input.localEventId,
      objectType: input.objectType,
      objectRef: input.objectRef,
      dedupDigest: input.rawBodyDigest,
      allowed: true,
      reason: 'refresh-hint',
    },
  };
}
