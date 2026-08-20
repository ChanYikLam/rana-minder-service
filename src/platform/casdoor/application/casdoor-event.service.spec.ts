import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { CasdoorEventService } from './casdoor-event.service';

const receivedAt = '2026-08-20T00:00:00.000Z';

function makeService(
  overrides: { enabled?: boolean; staticSecret?: string | null; maxSeenEntries?: number } = {},
) {
  return new CasdoorEventService(
    overrides.enabled ?? true,
    overrides.staticSecret ?? 'secret',
    overrides.maxSeenEntries,
  );
}

function handle(service: CasdoorEventService, digest: string, localEventId: string) {
  return service.handleWebhook({
    receivedAt,
    localEventId,
    objectType: 'USER',
    objectRef: 'u1',
    rawBodyDigest: digest,
    secretHeader: 'secret',
    rateLimitAvailable: true,
  });
}

describe('CasdoorEventService', () => {
  it('默认关闭时拒绝且不记录去重', async () => {
    const service = new CasdoorEventService();
    const result = await handle(service, 'd1', 'e1');
    assert.equal(result.accepted, false);
    // 同一事件在启用前不产生去重副作用
    const again = await handle(service, 'd1', 'e2');
    assert.equal(again.accepted, false);
  });

  it('重复事件被本地去重拒绝（CAS-EVT-004）', async () => {
    const service = makeService();
    const first = await handle(service, 'd1', 'e1');
    assert.equal(first.accepted, true);
    const duplicate = await handle(service, 'd1', 'e2');
    assert.equal(duplicate.accepted, false);
    assert.match(duplicate.reason, /去重/);
  });

  it('去重集合有界：超容量后淘汰最早记录，不再无界增长', async () => {
    const service = makeService({ maxSeenEntries: 3 });
    for (let i = 1; i <= 4; i += 1) {
      const result = await handle(service, `d${i}`, `e${i}`);
      assert.equal(result.accepted, true);
    }
    // 最早的 d1 已被淘汰，重发会再次被接受（不再命中去重）
    const oldestAgain = await handle(service, 'd1', 'e5');
    assert.equal(oldestAgain.accepted, true);
    // 仍在集合内的 d4 重发仍被去重
    const recentAgain = await handle(service, 'd4', 'e6');
    assert.equal(recentAgain.accepted, false);
  });
});
