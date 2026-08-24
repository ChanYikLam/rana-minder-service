/**
 * 外部备份适配器单测（P2 零覆盖补测；ADR-011 §6.3）。
 *
 * 关键语义：未知/不可识别中间态记录跳过（状态页显示"未知"），不把
 * "不确定"伪装成 failure；HTTP 失败/网络异常返回空集（不伪造备份记录）。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { ExternalBackupAdapter } from './external-backup.adapter';

interface Call {
  url: string;
  init: RequestInit;
}

function makeAdapter(responder: (url: string) => { status: number; body: unknown }): {
  adapter: ExternalBackupAdapter;
  calls: Call[];
} {
  const calls: Call[] = [];
  const fetchFn = (async (input: string | URL, init: RequestInit = {}) => {
    const url = typeof input === 'string' ? input : String(input);
    calls.push({ url, init });
    const r = responder(url);
    return new Response(JSON.stringify(r.body), { status: r.status });
  }) as typeof fetch;
  const adapter = new ExternalBackupAdapter({
    endpoint: 'https://ops.example.com',
    token: 'tk',
    fetchFn,
  });
  return { adapter, calls };
}

const OK_BACKUP = {
  records: [
    {
      backupId: 'bk-1',
      startedAt: '2026-08-23T00:00:00.000Z',
      completedAt: '2026-08-23T00:10:00.000Z',
      status: 'success',
      sizeBytes: 1024,
      location: 's3://bucket/bk-1',
    },
  ],
};

describe('ExternalBackupAdapter', () => {
  it('lastBackup：解析 success 记录并映射字段', async () => {
    const { adapter } = makeAdapter(() => ({ status: 200, body: OK_BACKUP }));
    const r = await adapter.lastBackup();
    assert.equal(r?.backupId, 'bk-1');
    assert.equal(r?.status, 'success');
    assert.equal(r?.sizeBytes, 1024);
  });

  it('未知中间态记录被跳过（不伪装为 failure，ADR-011 §6.3）', async () => {
    const { adapter } = makeAdapter(() => ({
      status: 200,
      body: {
        records: [
          { backupId: 'bk-x', startedAt: '2026-08-23T00:00:00.000Z', status: 'running' },
          OK_BACKUP.records[0],
        ],
      },
    }));
    const list = await adapter.recentBackups(10);
    assert.equal(list.length, 1);
    assert.equal(list[0].backupId, 'bk-1');
  });

  it('非 2xx → 空集（不伪造记录、不抛错）', async () => {
    const { adapter } = makeAdapter(() => ({ status: 503, body: {} }));
    assert.equal(await adapter.lastBackup(), undefined);
    assert.deepEqual(await adapter.recentBackups(5), []);
  });

  it('网络异常（fetch 抛错）→ 空集', async () => {
    const fetchFn = (async () => {
      throw new Error('ECONNREFUSED');
    }) as typeof fetch;
    const adapter = new ExternalBackupAdapter({ endpoint: 'https://x', fetchFn });
    assert.equal(await adapter.lastRestore(), undefined);
  });

  it('携带 Bearer token 且 limit 参与查询串', async () => {
    const { adapter, calls } = makeAdapter(() => ({ status: 200, body: { records: [] } }));
    await adapter.recentBackups(7);
    const headers = calls[0]?.init.headers as Record<string, string>;
    assert.equal(headers['Authorization'], 'Bearer tk');
    assert.ok(calls[0]?.url.includes('limit=7'));
  });
});
