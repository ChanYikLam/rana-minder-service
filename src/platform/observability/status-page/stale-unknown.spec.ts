import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { DefaultStaleUnknownRule } from './stale-unknown';

describe('stale-unknown (DefaultStaleUnknownRule)', () => {
  const rule = new DefaultStaleUnknownRule();
  const NOW = new Date('2026-08-18T00:00:00.000Z');

  it('lastCheckedAt 缺失 → unknown', () => {
    const r = rule.evaluate({ lastCheckedAt: undefined, maxAgeMs: 1000, now: NOW });
    assert.equal(r.state, 'unknown');
    assert.equal(r.ageMs, undefined);
  });

  it('age 在 maxAgeMs 内 → fresh 带 ageMs', () => {
    const last = new Date(NOW.getTime() - 500);
    const r = rule.evaluate({ lastCheckedAt: last, maxAgeMs: 1000, now: NOW });
    assert.equal(r.state, 'fresh');
    assert.equal(r.ageMs, 500);
  });

  it('age 超过 maxAgeMs → stale 带 ageMs', () => {
    const last = new Date(NOW.getTime() - 5000);
    const r = rule.evaluate({ lastCheckedAt: last, maxAgeMs: 1000, now: NOW });
    assert.equal(r.state, 'stale');
    assert.equal(r.ageMs, 5000);
  });

  it('时钟回拨（ageMs < 0）→ unknown（保守）', () => {
    const last = new Date(NOW.getTime() + 1000);
    const r = rule.evaluate({ lastCheckedAt: last, maxAgeMs: 1000, now: NOW });
    assert.equal(r.state, 'unknown');
  });

  it('ageMs 边界恰好等于 maxAgeMs 仍 fresh', () => {
    const last = new Date(NOW.getTime() - 1000);
    const r = rule.evaluate({ lastCheckedAt: last, maxAgeMs: 1000, now: NOW });
    assert.equal(r.state, 'fresh');
  });
});
