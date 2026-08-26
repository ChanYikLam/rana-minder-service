/**
 * 身份模块 nest 接口层测试（P1 任务③；response-mapper + auth-session + guard）。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { toHttpResponse, toActorContext } from './response-mapper';
import { RejectAllAuthSessionProvider, type AuthSession } from './auth-session';

const NOW = new Date('2026-08-01T00:00:00Z');

describe('toHttpResponse（API-GEN-004）', () => {
  it('成功路径：{ ok: true, value } → { code: 0, data: value }', () => {
    const r = toHttpResponse({ ok: true, value: { id: 'x' } });
    assert.deepEqual(r, { code: 0, data: { id: 'x' } });
  });

  it('错误路径：{ ok: false, status, body } → HttpException', () => {
    assert.throws(
      () =>
        toHttpResponse({
          ok: false,
          status: 403,
          body: { code: 'IFC-ERR-002', message: 'forbidden' },
        } as never),
      (e: unknown) => {
        const httpErr = e as { status?: number; response?: { code?: string } };
        return httpErr.status === 403 && httpErr.response?.code === 'IFC-ERR-002';
      },
    );
  });
});

describe('toActorContext（AUT 分面）', () => {
  it('从会话构造 ActorContext：subjectId 来自会话而非请求方自报', () => {
    const session: AuthSession = {
      subjectId: 'u_real',
      now: NOW,
      mailCapable: true,
    };
    const ctx = toActorContext(session, 'trace-123');
    assert.equal(ctx.subjectId, 'u_real');
    assert.equal(ctx.traceId, 'trace-123');
    assert.equal(ctx.mailCapable, true);
  });

  it('traceId 缺失时自动生成', () => {
    const ctx = toActorContext({ subjectId: 'u1', now: NOW }, null);
    assert.ok(ctx.traceId && ctx.traceId.length > 0);
  });

  it('mailCapable 缺省 → false（安全保守）', () => {
    const ctx = toActorContext({ subjectId: 'u1', now: NOW }, null);
    assert.equal(ctx.mailCapable, false);
  });
});

describe('RejectAllAuthSessionProvider（fail-closed）', () => {
  it('resolveSession 一律返回 null（未认证 → 守卫 401）', async () => {
    const provider = new RejectAllAuthSessionProvider();
    const r = await provider.resolveSession({ headers: {} } as never);
    assert.equal(r, null);
  });
});
