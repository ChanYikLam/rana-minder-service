/**
 * 外部通知渠道适配器单测（P2 零覆盖补测；IFC-TX-005）。
 *
 * 关键语义：成功以外部消息 ID 为准；2xx 无 ID → UNCERTAIN；
 * 5xx/429/网络 → RETRYABLE_FAILURE，其余 4xx → NON_RETRYABLE。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { HttpNotifyAdapter } from './external-notify.adapter';

function makeAdapter(responder: (url: string) => { status: number; body: string }): {
  adapter: HttpNotifyAdapter;
  calls: Array<{ url: string; init: RequestInit }>;
} {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchFn = (async (input: string | URL, init: RequestInit = {}) => {
    const url = typeof input === 'string' ? input : String(input);
    calls.push({ url, init });
    const r = responder(url);
    return new Response(r.body, { status: r.status });
  }) as typeof fetch;
  const adapter = new HttpNotifyAdapter({
    endpoint: 'https://notify.example.com',
    token: 'tk',
    fetchFn,
  });
  return { adapter, calls };
}

const DISPATCH = {
  channel: 'push' as const,
  recipient: 'SYN-U-1',
  templateId: 'org-member',
  params: { title: '[SYN] t', body: '[SYN] b' },
  idempotencyKey: 'dedup:1',
};

describe('HttpNotifyAdapter', () => {
  it('成功：返回外部消息 ID 且 status=SUCCESS', async () => {
    const { adapter } = makeAdapter(() => ({
      status: 200,
      body: JSON.stringify({ externalMessageId: 'm-1' }),
    }));
    const r = await adapter.send(DISPATCH);
    assert.equal(r.status, 'SUCCESS');
    assert.equal(r.data?.externalMessageId, 'm-1');
  });

  it('2xx 但无消息 ID → UNCERTAIN（不得以 HTTP 成功宣称成功）', async () => {
    const { adapter } = makeAdapter(() => ({ status: 200, body: '{}' }));
    const r = await adapter.send(DISPATCH);
    assert.equal(r.status, 'UNCERTAIN');
    assert.equal(r.error?.code, 'NOTIFY-NO-MESSAGE-ID');
    assert.equal(r.error?.retryable, true);
  });

  it('5xx → RETRYABLE_FAILURE；4xx → NON_RETRYABLE', async () => {
    const retry = makeAdapter(() => ({ status: 503, body: '' }));
    const r1 = await retry.adapter.send(DISPATCH);
    assert.equal(r1.status, 'RETRYABLE_FAILURE');
    assert.equal(r1.error?.retryable, true);

    const reject = makeAdapter(() => ({ status: 400, body: '' }));
    const r2 = await reject.adapter.send(DISPATCH);
    assert.equal(r2.status, 'NON_RETRYABLE');
    assert.equal(r2.error?.retryable, false);
  });

  it('请求体携带幂等键与脱敏参数；Bearer token 注入', async () => {
    const { adapter, calls } = makeAdapter(() => ({
      status: 200,
      body: JSON.stringify({ externalMessageId: 'm' }),
    }));
    await adapter.send(DISPATCH);
    const headers = calls[0]?.init.headers as Record<string, string>;
    assert.equal(headers['Authorization'], 'Bearer tk');
    const body = JSON.parse(String(calls[0]?.init.body)) as Record<string, unknown>;
    assert.equal(body['idempotencyKey'], 'dedup:1');
    assert.equal(body['recipient'], 'SYN-U-1');
  });
});
