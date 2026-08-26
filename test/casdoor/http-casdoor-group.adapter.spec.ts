/**
 * Casdoor 管理 API HTTP 适配器测试（ADR-009 §2.1、CAS-READ-*、CAS-WR-006~010、CAS-CAP-010）。
 *
 * 契约锚点：
 * - `CAS-WR-006/007`（写后定向读回）：写入响应只是尝试证据——不以 HTTP 2xx 宣称成功，
 *   必须回读目标 Group 实况确认后才返回 success；读回不符返回 unknown（CAS-WR-010
 *   部分成功不得授予新权限，交由状态机补偿/异常）；
 * - `CAS-FAIL-005`：保留「明确拒绝/明确失败/超时/连接中断/响应不可解析」的区别；
 *   面向调用者仅暴露安全分类+状态码，**不回显**令牌、秘密或完整上游响应（脱敏）；
 * - `CAS-CAP-010`：超时/连接失败/错误分类须可区分；404 才是"不存在"，5xx/网络故障
 *   上抛为瞬时错误，严禁伪装成空目录或 deleted（ORG-026）。
 *
 * 确定性：fetch 经构造器选项注入桩实现（记录每次请求并返回 canned 响应），无真实网络；
 * 超时用极短 timeoutMs 驱动真实 AbortController 路径。被测文件不引用 jose/pg，
 * 可静态导入。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { HttpCasdoorGroupAdapter } from '../../src/modules/organization/infrastructure/http/http-casdoor-group.adapter';
import type { CasdoorWriteResult } from '../../src/modules/organization/application/ports';

// ---------------------------------------------------------------------------
// fetch 桩：记录请求并按路由返回 canned 响应
// ---------------------------------------------------------------------------

interface RecordedCall {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: string | undefined;
}

type RouteResult = { status: number; body: unknown } | { boom: Error } | { hang: true };

type AdapterOptions = ConstructorParameters<typeof HttpCasdoorGroupAdapter>[0];

function makeAdapter(
  route: (call: RecordedCall) => RouteResult,
  overrides: Partial<AdapterOptions> = {},
): { adapter: HttpCasdoorGroupAdapter; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const fetchFn = (async (input: string | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const call: RecordedCall = {
      url,
      method: init?.method ?? 'GET',
      headers: headerMap(init),
      body: typeof init?.body === 'string' ? init.body : undefined,
    };
    calls.push(call);
    const result = route(call);
    if ('hang' in result) {
      return new Promise<Response>((_resolve, reject) => {
        const onAbort = (): void => {
          reject(new DOMException('The operation was aborted.', 'AbortError'));
        };
        const signal = init?.signal;
        if (signal?.aborted) onAbort();
        else signal?.addEventListener('abort', onAbort, { once: true });
        // 不主动完成：由适配器的超时定时器触发中止
      });
    }
    if ('boom' in result) throw result.boom;
    const text = typeof result.body === 'string' ? result.body : JSON.stringify(result.body);
    return {
      ok: result.status >= 200 && result.status < 300,
      status: result.status,
      text: async () => text,
    } as unknown as Response;
  }) as unknown as typeof fetch;

  return { adapter: buildAdapter({ fetchFn, ...overrides }), calls };
}

function headerMap(init?: RequestInit): Record<string, string> {
  const out: Record<string, string> = {};
  const h = init?.headers as Record<string, string> | undefined;
  if (h) for (const [k, v] of Object.entries(h)) out[String(k)] = String(v);
  return out;
}

function buildAdapter(options: Partial<AdapterOptions>): HttpCasdoorGroupAdapter {
  return new HttpCasdoorGroupAdapter({
    endpoint: 'https://casdoor.school.edu.cn/',
    clientId: 'test-client-id',
    clientSecret: 'test-client-secret-value',
    organization: 'school-org',
    ...options,
  });
}

const REF = { owner: 'school-org', name: 'club-a-member' } as const;

/** 标准 get-group 元数据（携带成员数组）。 */
function groupMeta(): Record<string, unknown> {
  return {
    id: 'group-pk-1',
    owner: 'school-org',
    name: 'club-a-member',
    displayName: '社团A成员组',
    parentId: 'school-org/club-a-root',
    users: [{ id: 'u_1001' }, { id: 'u_1002' }],
  };
}

describe('HttpCasdoorGroupAdapter 成功路径（请求形状 + 映射）', () => {
  it('listGroups：GET {endpoint}/api/get-groups?owner=<org>，Basic 凭据在 Authorization 头（不进 URL）', async () => {
    const { adapter, calls } = makeAdapter(() => ({
      status: 200,
      body: [groupMeta()],
    }));

    const groups = await adapter.listGroups();

    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, 'GET');
    assert.ok(calls[0].url.startsWith('https://casdoor.school.edu.cn/api/get-groups'));
    assert.ok(calls[0].url.includes(`owner=${encodeURIComponent('school-org')}`));
    // 尾随斜杠被归一化，未产生 //
    assert.ok(!calls[0].url.includes('//api'));
    const expectedBasic = Buffer.from('test-client-id:test-client-secret-value').toString('base64');
    assert.equal(calls[0].headers['Authorization'], `Basic ${expectedBasic}`);
    assert.ok(!calls[0].url.includes('test-client-secret-value'));

    assert.equal(groups.length, 1);
    assert.deepEqual(groups[0].ref, { owner: 'school-org', name: 'club-a-member' });
    assert.equal(groups[0].stableId, 'group-pk-1');
    assert.equal(groups[0].displayName, '社团A成员组');
    assert.equal(groups[0].path, '/school-org/club-a-root/club-a-member');
    assert.deepEqual(groups[0].parentRef, { owner: 'school-org', name: 'club-a-root' });
    assert.deepEqual([...groups[0].memberIds], ['u_1001', 'u_1002']);
  });

  it('writeMembership add：写后定向读回确认成员已入 → success（CAS-WR-007：读回收口而非 2xx 收口）', async () => {
    let step = 0;
    const { adapter, calls } = makeAdapter((call) => {
      step += 1;
      if (step === 1) {
        assert.ok(call.url.includes('/api/get-group?owner=school-org&name=club-a-member'));
        return { status: 200, body: groupMeta() };
      }
      if (step === 2) {
        assert.equal(call.method, 'POST');
        assert.ok(call.url.endsWith('/api/add-user-to-group'));
        assert.deepEqual(JSON.parse(call.body ?? '{}'), {
          id: 'group-pk-1',
          userId: 'u_new',
        });
        return { status: 200, body: { status: 'ok' } }; // 写响应 ≠ 业务完成（CAS-WR-006）
      }
      assert.ok(call.url.includes('/api/get-group-users?id=group-pk-1'));
      return { status: 200, body: [{ id: 'u_1001' }, { id: 'u_new' }] };
    });

    const result: CasdoorWriteResult = await adapter.writeMembership({
      ref: REF,
      subjectId: 'u_new',
      action: 'add',
      requestId: 'req-1',
    });

    assert.equal(calls.length, 3); // 读 → 写 → 回读（顺序固定）
    assert.deepEqual(result, { requestId: 'req-1', outcome: 'success' });
  });

  it('writeMembership remove：回读确认主体已不在 → success', async () => {
    let step = 0;
    const { adapter } = makeAdapter((call) => {
      step += 1;
      if (step === 1) return { status: 200, body: groupMeta() };
      if (step === 2) {
        assert.ok(call.url.endsWith('/api/remove-user-from-group'));
        return { status: 200, body: { status: 'ok' } };
      }
      return { status: 200, body: [{ id: 'u_1002' }] };
    });

    const result = await adapter.writeMembership({
      ref: REF,
      subjectId: 'u_1001',
      action: 'remove',
      requestId: 'req-2',
    });
    assert.equal(result.outcome, 'success');
  });
});

describe('HttpCasdoorGroupAdapter 部分失败（CAS-WR-010：部分成功不得宣称完成）', () => {
  it('写入 2xx 但读回未见目标主体（add 未生效）→ unknown，不返回 success', async () => {
    let step = 0;
    const { adapter } = makeAdapter(() => {
      step += 1;
      if (step === 1) return { status: 200, body: groupMeta() };
      if (step === 2) return { status: 200, body: { status: 'ok' } }; // 写接受
      return { status: 200, body: [{ id: 'u_1001' }] }; // 回读：u_new 缺席 → 部分失败
    });

    const result = await adapter.writeMembership({
      ref: REF,
      subjectId: 'u_new',
      action: 'add',
      requestId: 'req-3',
    });

    assert.equal(result.outcome, 'unknown');
    assert.equal(result.requestId, 'req-3');
    assert.match(result.error ?? '', /readback not confirming/);
  });

  it('remove 后读回主体仍在（撤权未生效）→ unknown（保持最小权限语义）', async () => {
    let step = 0;
    const { adapter } = makeAdapter(() => {
      step += 1;
      if (step === 1) return { status: 200, body: groupMeta() };
      if (step === 2) return { status: 200, body: { status: 'ok' } };
      return { status: 200, body: [{ id: 'u_1001' }, { id: 'u_1002' }] };
    });

    const result = await adapter.writeMembership({
      ref: REF,
      subjectId: 'u_1001',
      action: 'remove',
      requestId: 'req-4',
    });
    assert.equal(result.outcome, 'unknown');
  });

  it("复合命令前置：get-group 瞬时故障 → 可重试 unknown（'transient' 分类，不误判为 not found）", async () => {
    const { adapter } = makeAdapter(() => ({ status: 500, body: { error: 'boom' } }));
    const result = await adapter.writeMembership({
      ref: REF,
      subjectId: 'u_x',
      action: 'add',
      requestId: 'req-5',
    });
    assert.equal(result.outcome, 'unknown');
    assert.match(result.error ?? '', /transient/);
  });

  it('get-group 404 → 明确失败（group not found，非 unknown）', async () => {
    const { adapter } = makeAdapter(() => ({ status: 404, body: { status: 'error' } }));
    const result = await adapter.writeMembership({
      ref: REF,
      subjectId: 'u_x',
      action: 'add',
      requestId: 'req-6',
    });
    assert.equal(result.outcome, 'failure');
    assert.match(result.error ?? '', /not found/);
  });
});

describe('HttpCasdoorGroupAdapter 超时（CAS-CAP-010：超时可区分且可重试）', () => {
  it(
    'listGroups 挂起 → 在超时窗内中止并抛瞬时故障（status=network 分类）',
    { timeout: 8000 },
    async () => {
      const { adapter, calls } = makeAdapter(() => ({ hang: true }), { timeoutMs: 40 });
      await assert.rejects(adapter.listGroups(), /list-groups failed \(status=network\)/);
      assert.equal(calls.length, 1);
    },
  );

  it(
    'write POST 阶段超时 → unknown 可重试分类（status===0 归入重试面）',
    { timeout: 8000 },
    async () => {
      let step = 0;
      const { adapter } = makeAdapter(
        () => {
          step += 1;
          if (step <= 1) return { status: 200, body: groupMeta() };
          return { hang: true }; // 写请求挂起
        },
        { timeoutMs: 40 },
      );

      const result = await adapter.writeMembership({
        ref: REF,
        subjectId: 'u_x',
        action: 'add',
        requestId: 'req-7',
      });
      // CAS-WR-002/003：租约重试前提是结果不确定；超时必须落在 unknown 而非 failure
      assert.equal(result.outcome, 'unknown');
      assert.match(result.error ?? '', /status=network/);
    },
  );

  it(
    'readback 阶段挂起 → 写结果不被确认为 success（fail-closed 到 unknown）',
    { timeout: 8000 },
    async () => {
      let step = 0;
      const { adapter } = makeAdapter(
        () => {
          step += 1;
          if (step === 1) return { status: 200, body: groupMeta() };
          if (step === 2) return { status: 200, body: { status: 'ok' } };
          return { hang: true }; // 回读挂起
        },
        { timeoutMs: 40 },
      );

      const result = await adapter.writeMembership({
        ref: REF,
        subjectId: 'u_new',
        action: 'add',
        requestId: 'req-8',
      });
      assert.equal(result.outcome, 'unknown');
      assert.match(result.error ?? '', /readback not confirming/);
    },
  );
});

describe('HttpCasdoorGroupAdapter 非 2xx（明确拒绝 vs 瞬时故障 vs 确实不存在）', () => {
  it('listGroups 500 → 抛瞬时故障（严禁伪装成空目录）', async () => {
    const { adapter } = makeAdapter(() => ({ status: 500, body: {} }));
    await assert.rejects(adapter.listGroups(), /list-groups failed \(status=500\)/);
  });

  it('listGroups 401/403 → 凭据失权单独分类（no_access ≠ 空）', async () => {
    const { adapter } = makeAdapter(() => ({ status: 401, body: {} }));
    await assert.rejects(adapter.listGroups(), /forbidden \(status=401\)/);
  });

  it('get-group 404 → null（唯一允许的「确实不存在」口径，ORG-026）', async () => {
    const { adapter } = makeAdapter(() => ({ status: 404, body: {} }));
    assert.equal(await adapter.getGroupByRef(REF), null);
  });

  it('get-group 401 但响应带元数据 → readable:false 的 Group（对账 no_access 数据源）', async () => {
    const { adapter } = makeAdapter(() => ({
      status: 403,
      body: { ...groupMeta(), users: undefined },
    }));
    const group = await adapter.getGroupByRef(REF);
    assert.ok(group);
    assert.equal(group.readable, false);
    assert.equal(group.stableId, 'group-pk-1');
  });

  it('get-group 401 且无元数据 → 最小化失权标记（不丢失 no_access 信号）', async () => {
    const { adapter } = makeAdapter(() => ({ status: 401, body: {} }));
    const group = await adapter.getGroupByRef(REF);
    assert.ok(group);
    assert.equal(group.readable, false);
    assert.deepEqual(group.ref, REF);
  });

  it('凭据失权后 getGroupMembers 上抛（不得误报为「无成员」）', async () => {
    const { adapter } = makeAdapter(() => ({ status: 403, body: {} }));
    await assert.rejects(adapter.getGroupMembers(REF), /not readable/);
  });

  it('write POST 非 2xx：400 → failure（明确拒绝不可重试）；429/5xx → unknown（有界重试面）', async () => {
    const rejected = makeAdapter((call) => {
      if (call.url.includes('/get-group')) return { status: 200, body: groupMeta() };
      return { status: 400, body: { status: 'error' } };
    });
    const r1 = await rejected.adapter.writeMembership({
      ref: REF,
      subjectId: 'u_x',
      action: 'add',
      requestId: 'r-400',
    });
    assert.equal(r1.outcome, 'failure');

    const throttled = makeAdapter((call) => {
      if (call.url.includes('/get-group')) return { status: 200, body: groupMeta() };
      return { status: 429, body: {} };
    });
    const r2 = await throttled.adapter.writeMembership({
      ref: REF,
      subjectId: 'u_x',
      action: 'add',
      requestId: 'r-429',
    });
    assert.equal(r2.outcome, 'unknown');

    const serverError = makeAdapter((call) => {
      if (call.url.includes('/get-group')) return { status: 200, body: groupMeta() };
      return { status: 503, body: {} };
    });
    const r3 = await serverError.adapter.writeMembership({
      ref: REF,
      subjectId: 'u_x',
      action: 'add',
      requestId: 'r-503',
    });
    assert.equal(r3.outcome, 'unknown');
  });
});

describe('HttpCasdoorGroupAdapter 坏 JSON / 畸形响应（响应不可解析 ≠ 不存在）', () => {
  it('listGroups 200 + 非 JSON 文本 → 抛 invalid body（不当空目录）', async () => {
    const { adapter } = makeAdapter(() => ({ status: 200, body: '<html>gateway error</html>' }));
    await assert.rejects(adapter.listGroups(), /invalid body \(status=200\)/);
  });

  it('get-group 200 + 空 body → 抛 empty body（null 会固化 deleted，禁止）', async () => {
    const { adapter } = makeAdapter(() => ({ status: 200, body: '' }));
    await assert.rejects(adapter.getGroupByRef(REF), /empty body/);
  });

  it('get-group 200 + 缺 id/name 元数据 → 抛 malformed body（畸形不得当 deleted）', async () => {
    const { adapter } = makeAdapter(() => ({ status: 200, body: { status: 'ok', data: null } }));
    await assert.rejects(adapter.getGroupByRef(REF), /malformed body/);
  });

  it('get-group-users 200 + 非数组（响应不可解析）且元数据无成员实况 → 上抛，不回落空集', async () => {
    const metaNoUsers = { ...groupMeta(), users: undefined };
    const { adapter } = makeAdapter((call) =>
      call.url.includes('/get-group-users')
        ? { status: 200, body: { unexpected: 'shape' } }
        : { status: 200, body: metaNoUsers },
    );
    await assert.rejects(adapter.getGroupMembers(REF), /get-group-users failed/);
  });

  it('元数据确实携带成员数组而成员接口读失败 → 允许回落复用同一请求内实况', async () => {
    const { adapter } = makeAdapter((call) =>
      call.url.includes('/get-group-users')
        ? { status: 500, body: {} }
        : { status: 200, body: groupMeta() },
    );
    const members = await adapter.getGroupMembers(REF);
    assert.deepEqual([...members], ['u_1001', 'u_1002']);
  });

  it('元数据缺省成员字段 + 成员接口读失败 → 上抛（缺省 [] 不得伪装成「无人」）', async () => {
    const metaNoUsers = { ...groupMeta(), users: undefined };
    const { adapter } = makeAdapter((call) =>
      call.url.includes('/get-group-users')
        ? { status: 502, body: {} }
        : { status: 200, body: metaNoUsers },
    );
    await assert.rejects(adapter.getGroupMembers(REF), /get-group-users failed/);
  });
});

describe('HttpCasdoorGroupAdapter 错误脱敏（CAS-FAIL-005 / CAS-SEC-003）', () => {
  it('上游 5xx 响应体含秘密/令牌 → 上抛错误只含安全分类与状态码，不回显正文', async () => {
    const leakyBody = {
      status: 'error',
      msg: 'invalid client_secret=test-client-secret-value token=eyJhbGciOiJub25lIn0.leak',
    };
    const { adapter } = makeAdapter(() => ({ status: 500, body: leakyBody }));

    await assert.rejects(adapter.listGroups(), (error: unknown) => {
      const msg = (error as Error).message;
      return (
        msg === 'casdoor list-groups failed (status=500)' &&
        !msg.includes('test-client-secret-value') &&
        !msg.includes('eyJhbGciOiJub25lIn0.leak')
      );
    });
  });

  it('传输层异常消息含敏感子串 → 不进入对外错误（仅 network 分类）', async () => {
    const { adapter } = makeAdapter(() => ({
      boom: new Error(
        'connect ECONNREFUSED for https://casdoor.school.edu.cn api key=hunter2 signature=deadbeef',
      ),
    }));
    await assert.rejects(adapter.listGroups(), (error: unknown) => {
      const msg = (error as Error).message;
      return (
        msg === 'casdoor list-groups failed (status=network)' &&
        !msg.includes('hunter2') &&
        !msg.includes('deadbeef')
      );
    });
  });

  it('写拒绝错误同样最小化：仅状态码分类，无上游 msg 字段回显', async () => {
    const { adapter } = makeAdapter((call) =>
      call.url.includes('/get-group')
        ? { status: 200, body: groupMeta() }
        : {
            status: 403,
            body: { status: 'error', msg: 'permission denied for client_secret=xyz secret=abc' },
          },
    );
    const result = await adapter.writeMembership({
      ref: REF,
      subjectId: 'u_x',
      action: 'add',
      requestId: 'redact-1',
    });
    assert.equal(result.outcome, 'failure');
    assert.match(result.error ?? '', /^casdoor write rejected \(status=403\)$/);
    assert.ok(!(result.error ?? '').includes('client_secret'));
    assert.ok(!(result.error ?? '').includes('permission denied'));
  });
});
