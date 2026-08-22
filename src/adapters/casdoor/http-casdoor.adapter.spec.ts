/**
 * T3 HttpCasdoorAdapter 单元测试。
 *
 * 覆盖：getUser 成功/404/不可用/异常响应；updateUser 写后定向读回收口
 * （CAS-WR-006/007：读回可见才成功，否则 UNCERTAIN）。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { HttpCasdoorAdapter } from './http-casdoor.adapter';

function makeFetch(
  responder: (
    url: string,
    init?: RequestInit,
  ) => Promise<{ ok: boolean; status: number; body: unknown }>,
): typeof fetch {
  return (async (url: unknown, init?: unknown) => {
    const { ok, status, body } = await responder(String(url), init as RequestInit | undefined);
    return {
      ok,
      status,
      text: async () => (body === null ? '' : JSON.stringify(body)),
    } as unknown as Response;
  }) as typeof fetch;
}

function userBody(overrides: Record<string, unknown> = {}) {
  return {
    id: 'u1',
    name: 'chen',
    studentId: null,
    email: 'chen@example.com',
    phone: null,
    college: 'cs',
    grade: null,
    state: 'ACTIVE',
    ...overrides,
  };
}

describe('HttpCasdoorAdapter', () => {
  it('getUser 成功返回规范化 CasdoorUser', async () => {
    const fetchFn = makeFetch(async () => ({ ok: true, status: 200, body: userBody() }));
    const adapter = new HttpCasdoorAdapter({
      endpoint: 'https://casdoor.example.com',
      clientId: 'c',
      organization: 'org',
      clientSecret: 's',
      fetchFn,
    });
    const res = await adapter.getUser('u1');
    assert.equal(res.status, 'SUCCESS');
    assert.equal(res.data?.email, 'chen@example.com');
  });

  it('getUser 404 返回 NOT_FOUND', async () => {
    const fetchFn = makeFetch(async () => ({ ok: false, status: 404, body: null }));
    const adapter = new HttpCasdoorAdapter({
      endpoint: 'https://casdoor.example.com',
      clientId: 'c',
      organization: 'org',
      clientSecret: 's',
      fetchFn,
    });
    const res = await adapter.getUser('missing');
    assert.equal(res.status, 'NOT_FOUND');
  });

  it('getUser 网络异常返回 UNAVAILABLE 可重试', async () => {
    const fetchFn = makeFetch(async () => {
      throw new Error('client_secret=secret ec2 down');
    });
    const adapter = new HttpCasdoorAdapter({
      endpoint: 'https://casdoor.example.com',
      clientId: 'c',
      organization: 'org',
      clientSecret: 's',
      fetchFn,
    });
    const res = await adapter.getUser('u1');
    assert.equal(res.status, 'UNAVAILABLE');
    assert.equal(res.error?.retryable, true);
    // 脱敏：不泄露密钥。
    assert.ok(!JSON.stringify(res.error).includes('secret'));
  });

  it('updateUser 写后读回可见才返回 SUCCESS（CAS-WR-006/007）', async () => {
    let updatedPhone = false;
    const fetchFn = makeFetch(async (url) => {
      if (url.includes('/api/update-user')) {
        updatedPhone = true;
        return { ok: true, status: 200, body: null };
      }
      // getUser readback
      return {
        ok: true,
        status: 200,
        body: userBody(updatedPhone ? { phone: '13900000000' } : {}),
      };
    });
    const adapter = new HttpCasdoorAdapter({
      endpoint: 'https://casdoor.example.com',
      clientId: 'c',
      organization: 'org',
      clientSecret: 's',
      fetchFn,
    });
    const res = await adapter.updateUser('u1', { phone: '13900000000' });
    assert.equal(res.status, 'SUCCESS');
  });

  it('updateUser 读回不可见返回 UNCERTAIN（不得以 HTTP 成功宣称成功）', async () => {
    const fetchFn = makeFetch(async (url) => {
      if (url.includes('/api/update-user')) {
        return { ok: true, status: 200, body: null };
      }
      // readback 不反映变更
      return { ok: true, status: 200, body: userBody({ phone: null }) };
    });
    const adapter = new HttpCasdoorAdapter({
      endpoint: 'https://casdoor.example.com',
      clientId: 'c',
      organization: 'org',
      clientSecret: 's',
      fetchFn,
    });
    const res = await adapter.updateUser('u1', { phone: '13900000000' });
    assert.equal(res.status, 'UNCERTAIN');
  });

  it('updateUser 空 patch 返回 NON_RETRYABLE', async () => {
    const adapter = new HttpCasdoorAdapter({
      endpoint: 'https://casdoor.example.com',
      clientId: 'c',
      organization: 'org',
      clientSecret: 's',
      fetchFn: makeFetch(async () => ({ ok: false, status: 500, body: null })),
    });
    const res = await adapter.updateUser('u1', {});
    assert.equal(res.status, 'NON_RETRYABLE');
  });
});
