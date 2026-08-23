/**
 * HttpCasdoorGroupAdapter：注入 fetchFn 的单测（写后定向读回门控、失败分类）。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { HttpCasdoorGroupAdapter } from './http-casdoor-group.adapter';

interface FetchCall {
  url: string;
  init: RequestInit;
}

function makeFetch(
  responder: (url: string, init: RequestInit) => { status: number; body: unknown },
): { adapter: HttpCasdoorGroupAdapter; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const fetchFn = (async (input: string | URL, init: RequestInit = {}) => {
    const url = typeof input === 'string' ? input : String(input);
    calls.push({ url, init });
    const r = responder(url, init);
    return new Response(JSON.stringify(r.body), { status: r.status });
  }) as typeof fetch;
  const adapter = new HttpCasdoorGroupAdapter({
    endpoint: 'https://casdoor.example.com',
    clientId: 'cid',
    clientSecret: 'secret',
    organization: 'club-acm',
    membersField: 'users',
    fetchFn,
  });
  return { adapter, calls };
}

const GROUP_BODY = {
  id: 'g-1',
  owner: 'club-acm',
  name: '宣传部',
  displayName: '宣传部',
  parentId: '',
  users: [{ id: 'u_c' }],
};

function isGroupUrl(url: string): boolean {
  return url.includes('/api/get-group?');
}
function isMembersUrl(url: string): boolean {
  return url.includes('/api/get-group-users?');
}

describe('HttpCasdoorGroupAdapter', () => {
  it('getGroupByRef：映射 stableId/parentRef/memberIds', async () => {
    const { adapter } = makeFetch(() => ({ status: 200, body: GROUP_BODY }));
    const g = await adapter.getGroupByRef({ owner: 'club-acm', name: '宣传部' });
    assert.equal(g?.stableId, 'g-1');
    assert.equal(g?.memberIds.length, 1);
    assert.equal(g?.deleted, false);
  });

  it('getGroupByRef：404 → null（对账判 deleted 的数据源）', async () => {
    const { adapter } = makeFetch(() => ({ status: 404, body: {} }));
    assert.equal(await adapter.getGroupByRef({ owner: 'x', name: 'y' }), null);
  });

  it('writeMembership add：2xx + 回读确认 → success', async () => {
    const { adapter } = makeFetch((url) => {
      if (isGroupUrl(url)) return { status: 200, body: GROUP_BODY };
      if (isMembersUrl(url)) return { status: 200, body: [{ id: 'u_c' }] };
      return { status: 200, body: { ok: true } };
    });
    const r = await adapter.writeMembership({
      ref: { owner: 'club-acm', name: '宣传部' },
      subjectId: 'u_c',
      action: 'add',
      requestId: 'req-1',
    });
    assert.equal(r.outcome, 'success');
  });

  it('writeMembership remove：2xx 但回读仍含主体 → unknown（不以 HTTP 成功宣称成功，CAS-WR-007）', async () => {
    const { adapter } = makeFetch((url) => {
      if (isGroupUrl(url)) return { status: 200, body: GROUP_BODY };
      if (isMembersUrl(url)) return { status: 200, body: [{ id: 'u_c' }] };
      return { status: 200, body: { ok: true } };
    });
    const r = await adapter.writeMembership({
      ref: { owner: 'club-acm', name: '宣传部' },
      subjectId: 'u_c',
      action: 'remove',
      requestId: 'req-2',
    });
    assert.equal(r.outcome, 'unknown');
  });

  it('writeMembership remove：2xx 但读回失败 → unknown（严禁读失败误报成功）', async () => {
    const { adapter } = makeFetch((url) => {
      if (isGroupUrl(url)) return { status: 200, body: GROUP_BODY };
      if (isMembersUrl(url)) return { status: 502, body: {} }; // 回读失败（瞬时故障）
      return { status: 200, body: { ok: true } };
    });
    const r = await adapter.writeMembership({
      ref: { owner: 'club-acm', name: '宣传部' },
      subjectId: 'u_c',
      action: 'remove',
      requestId: 'req-2b',
    });
    // 回读读不到真实成员实况，绝不能因空数组合 remove 恒真而误判 success
    assert.equal(r.outcome, 'unknown');
  });

  it('getGroupByRef：5xx 瞬时故障 → 上抛而非当作 deleted', async () => {
    const { adapter } = makeFetch(() => ({ status: 502, body: {} }));
    await assert.rejects(
      () => adapter.getGroupByRef({ owner: 'x', name: 'y' }),
      /casdoor get-group failed/,
    );
  });

  it('writeMembership：Group 不存在 → failure；5xx → unknown 可重试', async () => {
    const missing = makeFetch(() => ({ status: 404, body: {} }));
    const r1 = await missing.adapter.writeMembership({
      ref: { owner: 'club-acm', name: '宣传部' },
      subjectId: 'u_c',
      action: 'add',
      requestId: 'req-3',
    });
    assert.equal(r1.outcome, 'failure');

    let first = true;
    const serverErr = makeFetch((url) => {
      if (isGroupUrl(url)) return { status: 200, body: GROUP_BODY };
      if (first) {
        first = false;
        return { status: 502, body: {} };
      }
      return { status: 200, body: [] };
    });
    const r2 = await serverErr.adapter.writeMembership({
      ref: { owner: 'club-acm', name: '宣传部' },
      subjectId: 'u_c',
      action: 'add',
      requestId: 'req-4',
    });
    assert.equal(r2.outcome, 'unknown');
  });

  it('请求头携带 Basic 凭据且不落日志明文密钥', async () => {
    const { adapter, calls } = makeFetch(() => ({ status: 200, body: GROUP_BODY }));
    await adapter.getGroupByRef({ owner: 'club-acm', name: '宣传部' });
    const auth = (calls[0]?.init.headers as Record<string, string>)['Authorization'];
    assert.ok(auth.startsWith('Basic '));
    assert.ok(!auth.includes('secret'));
  });
});
