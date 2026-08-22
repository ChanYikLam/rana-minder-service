/**
 * 外部通知渠道适配器（adapters/notify/external-notify.adapter.ts；T3）。
 *
 * 权威依据：通知模块（NTF-001~009）、IFC-TX-005、SRS-FAIL-007。
 *
 * 职责：
 * - 站内信之外的"附加通知渠道"（如外部推送/短信/网关）的真实投递边界；
 * - 与邮件渠道一致：只承载投递，不成为通知事实权威；失败不改变业务/通知事实；
 * - 结果不确定时按外部消息 ID 查询/回读收口，不得以 HTTP 成功宣称成功；
 * - 错误脱敏，不回显密钥/令牌。
 *
 * 依赖可用性由 `ADAPTERS_NOTIFY_REAL=1` 开关控制（fail-closed，默认关闭）。
 */

import type { ExternalResult } from '../../common/contracts/external-result';
import { externalSuccess, externalFailure } from '../../common/contracts/external-result';
import { randomUUID } from 'node:crypto';
import { toRedactedErrorSummary } from '../redaction';

/** 外部通知投递意图（脱敏载荷，不携带业务正文/密钥）。 */
export interface ExternalNotifyDispatch {
  readonly channel: 'push' | 'sms' | 'external';
  readonly recipient: string;
  /** 模板标识（不携带具体正文内容） */
  readonly templateId: string;
  /** 脱敏后的渲染变量（不得含密钥/令牌/完整业务正文） */
  readonly params: Readonly<Record<string, string>>;
  /** 调用方生成的外部消息幂等键 */
  readonly idempotencyKey: string;
}

export interface ExternalNotifyResult {
  /** 外部消息标识（用于后续查询/回读收口） */
  readonly externalMessageId: string;
}

/** 外部通知渠道适配边界 token。 */
export const NOTIFY_ADAPTER = 'ADAPTERS_NOTIFY';

export interface NotifyAdapter {
  /** 投递外部通知；成功以外部接受并返回消息 ID 为准，写后回读由调用方收口。 */
  send(input: ExternalNotifyDispatch): Promise<ExternalResult<ExternalNotifyResult>>;
}

export interface ExternalNotifyAdapterOptions {
  readonly endpoint: string;
  readonly token?: string;
  readonly fetchFn?: typeof fetch;
  readonly timeoutMs?: number;
}

export class HttpNotifyAdapter implements NotifyAdapter {
  private readonly endpoint: string;
  private readonly token?: string;
  private readonly fetchFn: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: ExternalNotifyAdapterOptions) {
    this.endpoint = options.endpoint.replace(/\/+$/, '');
    this.token = options.token;
    this.fetchFn = options.fetchFn ?? globalThis.fetch.bind(globalThis);
    this.timeoutMs = options.timeoutMs ?? 10_000;
  }

  async send(input: ExternalNotifyDispatch): Promise<ExternalResult<ExternalNotifyResult>> {
    const attemptId = randomUUID();
    const timestamp = new Date();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchFn(`${this.endpoint}/api/notify/send`, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
        },
        body: JSON.stringify({
          channel: input.channel,
          recipient: input.recipient,
          templateId: input.templateId,
          params: input.params,
          idempotencyKey: input.idempotencyKey,
        }),
      });
      const text = await res.text();
      let messageId: string | null = null;
      try {
        const parsed = JSON.parse(text) as { externalMessageId?: string };
        messageId = typeof parsed?.externalMessageId === 'string' ? parsed.externalMessageId : null;
      } catch {
        messageId = null;
      }
      if (!res.ok) {
        const retryable = res.status === 0 || res.status >= 500 || res.status === 429;
        return externalFailure(
          retryable ? 'RETRYABLE_FAILURE' : 'NON_RETRYABLE',
          {
            code: retryable ? 'NOTIFY-DELIVERY-FAILED' : 'NOTIFY-REJECTED',
            message: `notify rejected:${res.status}`,
            retryable,
            rawStatusCode: res.status,
          },
          attemptId,
          timestamp,
        );
      }
      if (!messageId) {
        return externalFailure(
          'UNCERTAIN',
          {
            code: 'NOTIFY-NO-MESSAGE-ID',
            message: 'accepted but no message id returned',
            retryable: true,
            rawStatusCode: res.status,
          },
          attemptId,
          timestamp,
        );
      }
      return externalSuccess({ externalMessageId: messageId }, attemptId, timestamp);
    } catch (err) {
      const isAbort = err instanceof Error && err.name === 'AbortError';
      return externalFailure(
        'RETRYABLE_FAILURE',
        {
          code: 'NOTIFY-UNAVAILABLE',
          message: isAbort ? 'notify-timeout' : toRedactedErrorSummary(err),
          retryable: true,
          rawStatusCode: null,
        },
        attemptId,
        timestamp,
      );
    } finally {
      clearTimeout(timer);
    }
  }
}
