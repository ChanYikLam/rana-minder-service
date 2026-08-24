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

  it('getGroupByRef：403 → readable:false（对账 no_access 的数据源）', async () => {
    const { adapter } = makeFetch(() => ({
      status: 403,
      body: { id: 'g-1', owner: 'club-acm', name: '宣传部' },
    }));
    const g = await adapter.getGroupByRef({ owner: 'club-acm', name: '宣传部' });
    assert.equal(g?.readable, false);
    assert.equal(g?.deleted, false);
  });

  it('getGroupByRef：403 且无元数据 → 仍返回 readable:false（不失失权信号）', async () => {
    const { adapter } = makeFetch(() => ({ status: 403, body: {} }));
    const g = await adapter.getGroupByRef({ owner: 'club-acm', name: '宣传部' });
    assert.equal(g?.readable, false);
    assert.equal(g?.stableId, '宣传部');
  });

  it('getGroupByRef：200 但空 body → 上抛而非误判 deleted', async () => {
    const { adapter } = makeFetch(() => ({ status: 200, body: null }));
    await assert.rejects(() => adapter.getGroupByRef({ owner: 'x', name: 'y' }), /empty body/);
  });

  it('getGroupByRef：200 但缺 id/name 元数据 → 上抛而非误判 deleted（fail-closed）', async () => {
    // 畸形响应若映射为 null，会被对账固化为 deleted 异常（竞争/容错误判）
    const { adapter } = makeFetch(() => ({ status: 200, body: { owner: 'club-acm' } }));
    await assert.rejects(
      () => adapter.getGroupByRef({ owner: 'club-acm', name: '宣传部' }),
      /malformed body/,
    );
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

  it('getGroupMembers：回退路径不重复 fetch Group（复用已取元数据）', async () => {
    let groupFetchCount = 0;
    const { adapter, calls } = makeFetch((url) => {
      if (isGroupUrl(url)) {
        groupFetchCount += 1;
        return { status: 200, body: GROUP_BODY };
      }
      if (isMembersUrl(url)) return { status: 502, body: {} }; // 成员实况读失败 → 走回退
      return { status: 200, body: {} };
    });
    const members = await adapter.getGroupMembers({ owner: 'club-acm', name: '宣传部' });
    assert.deepEqual(members, ['u_c']); // 回落元数据内嵌成员
    assert.equal(groupFetchCount, 1); // 只 fetch 了一次 Group
    const groupUrls = calls.filter((c) => isGroupUrl(c.url)).length;
    assert.equal(groupUrls, 1);
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

  it('getGroupMembers：readable=false 上抛而非回落空 []（不把失权误报为无成员）', async () => {
    const { adapter } = makeFetch((url) => {
      if (isGroupUrl(url))
        return { status: 403, body: { id: 'g-1', owner: 'club-acm', name: '宣传部' } };
      return { status: 200, body: [] };
    });
    await assert.rejects(
      () => adapter.getGroupMembers({ owner: 'club-acm', name: '宣传部' }),
      /not readable/,
    );
  });

  it('readback：瞬时故障/失权上抛，不吞掉异常置空 []', async () => {
    const { adapter } = makeFetch(() => ({ status: 502, body: {} }));
    await assert.rejects(
      () => adapter.readback([{ owner: 'club-acm', name: '宣传部' }]),
      /casdoor get-group failed/,
    );
  });

  it('readback：readable=false 上抛而非回落空 []', async () => {
    const { adapter } = makeFetch((url) => {
      if (isGroupUrl(url))
        return { status: 403, body: { id: 'g-1', owner: 'club-acm', name: '宣传部' } };
      return { status: 200, body: [] };
    });
    await assert.rejects(
      () => adapter.readback([{ owner: 'club-acm', name: '宣传部' }]),
      /not readable/,
    );
  });

  it('listGroups：403 → 上抛而非返回空目录（不掩盖 no_access 信号）', async () => {
    const { adapter } = makeFetch(() => ({ status: 403, body: {} }));
    await assert.rejects(() => adapter.listGroups(), /list-groups forbidden/);
  });

  it('listGroups：5xx 瞬时故障 → 上抛而非返回空目录', async () => {
    const { adapter } = makeFetch(() => ({ status: 502, body: {} }));
    await assert.rejects(() => adapter.listGroups(), /list-groups failed/);
  });

  it('listGroups：200 空数组 → 返回空目录（确实无 Group）', async () => {
    const { adapter } = makeFetch(() => ({ status: 200, body: [] }));
    assert.deepEqual(await adapter.listGroups(), []);
  });
});
