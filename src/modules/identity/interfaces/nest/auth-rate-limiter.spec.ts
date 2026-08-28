/**
 * AuthRateLimiter 单元测试（认证端点限流）。
 *
 * 校验：窗口内放行、超限拒绝（含 Retry-After）、窗口翻转后重置、
 * 按 key 隔离、全局桶独立计数、超限请求同样计数（防重试风暴穿透）。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { AuthRateLimiter } from './auth-rate-limiter';

function makeLimiter(
  overrides: {
    maxPerKey?: number;
    maxGlobal?: number;
    windowMs?: number;
  } = {},
) {
  let now = 1_000_000;
  const limiter = new AuthRateLimiter({
    windowMs: overrides.windowMs ?? 60_000,
    maxPerKeyPerWindow: overrides.maxPerKey ?? 3,
    maxGlobalPerWindow: overrides.maxGlobal ?? 10,
    now: () => now,
  });
  return {
    limiter,
    advance(ms: number) {
      now += ms;
    },
  };
}

describe('AuthRateLimiter（固定窗口双桶）', () => {
  it('窗口内前 N 次放行，超限拒绝并给出 Retry-After', () => {
    const { limiter } = makeLimiter({ maxPerKey: 3 });
    assert.equal(limiter.check('ip-a').ok, true);
    assert.equal(limiter.check('ip-a').ok, true);
    const third = limiter.check('ip-a');
    assert.equal(third.ok, true);
    const fourth = limiter.check('ip-a');
    assert.equal(fourth.ok, false);
    assert.ok(fourth.retryAfterSec >= 1 && fourth.retryAfterSec <= 60);
  });

  it('窗口翻转后计数重置', () => {
    const { limiter, advance } = makeLimiter({ maxPerKey: 2, windowMs: 60_000 });
    limiter.check('ip-a');
    limiter.check('ip-a');
    assert.equal(limiter.check('ip-a').ok, false);
    advance(60_000);
    assert.equal(limiter.check('ip-a').ok, true, '新窗口应放行');
  });

  it('按 key 隔离：一个来源超限不影响其他来源', () => {
    const { limiter } = makeLimiter({ maxPerKey: 1 });
    assert.equal(limiter.check('ip-a').ok, true);
    assert.equal(limiter.check('ip-a').ok, false);
    assert.equal(limiter.check('ip-b').ok, true, '不同来源独立计数');
  });

  it('全局桶独立于单 key 桶（聚合暴露上限）', () => {
    const { limiter } = makeLimiter({ maxPerKey: 10, maxGlobal: 3 });
    assert.equal(limiter.check('ip-a').ok, true);
    assert.equal(limiter.check('ip-b').ok, true);
    assert.equal(limiter.check('ip-c').ok, true);
    assert.equal(limiter.check('ip-d').ok, false, '全局配额耗尽即拒绝');
  });

  it('超限请求同样计数：持续重试不会穿透窗口边界', () => {
    const { limiter } = makeLimiter({ maxPerKey: 1 });
    limiter.check('ip-a');
    // 大量重试都被记数
    for (let i = 0; i < 10; i++) {
      limiter.check('ip-a');
    }
    assert.equal(limiter.check('ip-a').ok, false, '重试风暴不恢复配额');
  });

  it('全局桶窗口翻转后重置', () => {
    const { limiter, advance } = makeLimiter({ maxGlobal: 1, windowMs: 60_000 });
    assert.equal(limiter.check('ip-a').ok, true);
    assert.equal(limiter.check('ip-b').ok, false);
    advance(60_000);
    assert.equal(limiter.check('ip-c').ok, true, '全局桶新窗口重置');
  });
});
