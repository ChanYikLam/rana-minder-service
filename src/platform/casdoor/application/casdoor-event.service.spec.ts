import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { CasdoorEventService } from './casdoor-event.service';

function makeInput(overrides: Record<string, unknown> = {}) {
  return {
    receivedAt: '2026-08-20T00:00:00.000Z',
    localEventId: 'evt-1',
    objectType: 'GROUP' as const,
    objectRef: 'o/g',
    rawBodyDigest: 'digest-1',
    secretHeader: 'secret',
    rateLimitAvailable: true,
    ...overrides,
  };
}

describe('CasdoorEventService', () => {
  it('默认关闭时拒绝 Webhook', async () => {
    const svc = new CasdoorEventService();
    const result = await svc.handleWebhook(makeInput());
    assert.equal(result.accepted, false);
    assert.equal(result.envelope, null);
  });

  it('启用且保护齐全时接受并加入去重', async () => {
    const svc = new CasdoorEventService({ enabled: true, staticSecret: 'secret' });
    const first = await svc.handleWebhook(makeInput());
    assert.equal(first.accepted, true);

    // 相同 digest 再次到达 → 被去重拒绝
    const second = await svc.handleWebhook(makeInput());
    assert.equal(second.accepted, false);
  });

  it('去重窗口过后相同 digest 可再次接受', async () => {
    const svc = new CasdoorEventService({ enabled: true, staticSecret: 'secret' });
    await svc.handleWebhook(makeInput());
    const later = await svc.handleWebhook(
      makeInput({ receivedAt: new Date(Date.parse('2026-08-20T00:00:00.000Z') + CasdoorEventService.DEDUP_TTL_MS + 1).toISOString() }),
    );
    assert.equal(later.accepted, true);
  });

  it('去重集合超过上限时淘汰最旧条目', async () => {
    const svc = new CasdoorEventService({ enabled: true, staticSecret: 'secret' });
    const base = Date.parse('2026-08-20T00:00:00.000Z');
    // 填充超过上限
    for (let i = 0; i < CasdoorEventService.DEDUP_MAX_ENTRIES + 10; i++) {
      await svc.handleWebhook(
        makeInput({
          receivedAt: new Date(base + i).toISOString(),
          rawBodyDigest: `digest-${i}`,
        }),
      );
    }
    // 最旧的 digest 已被淘汰，可再次接受
    const oldDigest = await svc.handleWebhook(
      makeInput({ receivedAt: new Date(base).toISOString(), rawBodyDigest: 'digest-0' }),
    );
    assert.equal(oldDigest.accepted, true);
    // 最新的仍被去重（digest-10009 是最新加入的）
    const latestDigest = await svc.handleWebhook(
      makeInput({ receivedAt: new Date(base + CasdoorEventService.DEDUP_MAX_ENTRIES + 9).toISOString(), rawBodyDigest: `digest-${CasdoorEventService.DEDUP_MAX_ENTRIES + 9}` }),
    );
    assert.equal(latestDigest.accepted, false);
  });
});
