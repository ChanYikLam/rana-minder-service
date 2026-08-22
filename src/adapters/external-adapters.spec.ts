/**
 * T3 ExternalFileCheckAdapter / HttpNotifyAdapter / ExternalBackupAdapter 单元测试。
 *
 * 覆盖：服务不可用/超时降级（GOV-008 不得自动放行）、成功/失败分类、
 * 结果脱敏、备份记录映射与失败降级为空集。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ExternalFileCheckAdapter } from './file-check/external-file-check.adapter';
import { FileCheckOutcome } from '../modules/file/domain/state-machines/file-state-machine';
import { HttpNotifyAdapter } from './notify/external-notify.adapter';
import { ExternalBackupAdapter } from './backup/external-backup.adapter';

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
      json: async () => body,
    } as unknown as Response;
  }) as typeof fetch;
}

function fileRecord() {
  return {
    fileId: 'f1',
    uploaderId: 'u1',
    scope: { kind: 'club' },
    category: 'GENERIC',
    state: 'CHECKING',
    target: null,
    versionNo: 1,
    versions: [],
    uploadSession: null,
    checkRecord: null,
    createdAt: '2026-08-22T00:00:00Z',
  } as never;
}

describe('ExternalFileCheckAdapter（外部文件检查）', () => {
  it('服务返回 PASSED → outcome PASSED', async () => {
    const fetchFn = makeFetch(async () => ({ ok: true, status: 200, body: { verdict: 'PASSED' } }));
    const adapter = new ExternalFileCheckAdapter({
      endpoint: 'https://check.example.com',
      fetchFn,
    });
    const res = await adapter.check(fileRecord(), new Uint8Array([1]), 'image/png');
    assert.equal(res.outcome, FileCheckOutcome.PASSED);
    assert.equal(res.retryable, false);
  });

  it('服务返回 QUARANTINED → outcome QUARANTINED', async () => {
    const fetchFn = makeFetch(async () => ({
      ok: true,
      status: 200,
      body: { verdict: 'QUARANTINED' },
    }));
    const adapter = new ExternalFileCheckAdapter({
      endpoint: 'https://check.example.com',
      fetchFn,
    });
    const res = await adapter.check(fileRecord(), new Uint8Array([1]), 'image/png');
    assert.equal(res.outcome, FileCheckOutcome.QUARANTINED);
    assert.equal(res.retryable, false);
  });

  it('服务不可用/超时 → FAILED 且 retryable（GOV-008 不得放行）', async () => {
    const fetchFn = makeFetch(async () => {
      throw new Error('timeout');
    });
    const adapter = new ExternalFileCheckAdapter({
      endpoint: 'https://check.example.com',
      fetchFn,
    });
    const res = await adapter.check(fileRecord(), new Uint8Array([1]), 'image/png');
    assert.equal(res.outcome, FileCheckOutcome.FAILED);
    assert.equal(res.retryable, true);
  });

  it('服务 5xx → FAILED 且 retryable', async () => {
    const fetchFn = makeFetch(async () => ({ ok: false, status: 503, body: null }));
    const adapter = new ExternalFileCheckAdapter({
      endpoint: 'https://check.example.com',
      fetchFn,
    });
    const res = await adapter.check(fileRecord(), new Uint8Array([1]), 'image/png');
    assert.equal(res.retryable, true);
  });
});

describe('HttpNotifyAdapter（外部通知渠道）', () => {
  const dispatch = {
    channel: 'push' as const,
    recipient: 'u1',
    templateId: 't1',
    params: { key: 'value' },
    idempotencyKey: 'idem-1',
  };

  it('成功返回消息 ID', async () => {
    const fetchFn = makeFetch(async () => ({
      ok: true,
      status: 200,
      body: { externalMessageId: 'msg-1' },
    }));
    const adapter = new HttpNotifyAdapter({ endpoint: 'https://notify.example.com', fetchFn });
    const res = await adapter.send(dispatch);
    assert.equal(res.status, 'SUCCESS');
    assert.equal(res.data?.externalMessageId, 'msg-1');
  });

  it('无消息 ID → UNCERTAIN（不得以 HTTP 成功宣称成功）', async () => {
    const fetchFn = makeFetch(async () => ({ ok: true, status: 200, body: {} }));
    const adapter = new HttpNotifyAdapter({ endpoint: 'https://notify.example.com', fetchFn });
    const res = await adapter.send(dispatch);
    assert.equal(res.status, 'UNCERTAIN');
  });

  it('5xx → RETRYABLE_FAILURE', async () => {
    const fetchFn = makeFetch(async () => ({ ok: false, status: 500, body: null }));
    const adapter = new HttpNotifyAdapter({ endpoint: 'https://notify.example.com', fetchFn });
    const res = await adapter.send(dispatch);
    assert.equal(res.status, 'RETRYABLE_FAILURE');
    assert.equal(res.error?.retryable, true);
  });

  it('网络异常 → RETRYABLE_FAILURE 且脱敏', async () => {
    const fetchFn = makeFetch(async () => {
      throw new Error('token=abc network down');
    });
    const adapter = new HttpNotifyAdapter({ endpoint: 'https://notify.example.com', fetchFn });
    const res = await adapter.send(dispatch);
    assert.equal(res.status, 'RETRYABLE_FAILURE');
    assert.ok(!JSON.stringify(res.error).includes('abc'));
  });
});

describe('ExternalBackupAdapter（备份报告）', () => {
  it('成功返回最近备份记录', async () => {
    const fetchFn = makeFetch(async () => ({
      ok: true,
      status: 200,
      body: {
        records: [
          {
            backupId: 'b1',
            startedAt: '2026-08-22T00:00:00Z',
            completedAt: '2026-08-22T00:01:00Z',
            status: 'success',
            sizeBytes: 100,
            location: 's3://bucket/x',
          },
        ],
      },
    }));
    const adapter = new ExternalBackupAdapter({ endpoint: 'https://backup.example.com', fetchFn });
    const rec = await adapter.lastBackup();
    assert.equal(rec?.backupId, 'b1');
    assert.equal(rec?.status, 'success');
  });

  it('I/O 失败降级为空集（不抛异常，状态页显示未知）', async () => {
    const fetchFn = makeFetch(async () => {
      throw new Error('down');
    });
    const adapter = new ExternalBackupAdapter({ endpoint: 'https://backup.example.com', fetchFn });
    const rec = await adapter.lastBackup();
    assert.equal(rec, undefined);
    assert.deepEqual(await adapter.recentBackups(5), []);
  });

  it('5xx 降级为空集', async () => {
    const fetchFn = makeFetch(async () => ({ ok: false, status: 500, body: null }));
    const adapter = new ExternalBackupAdapter({ endpoint: 'https://backup.example.com', fetchFn });
    assert.equal(await adapter.lastRestore(), undefined);
  });

  it('未知状态记录被跳过（不伪造为确定的 failure，状态页显示未知）', async () => {
    const fetchFn = makeFetch(async () => ({
      ok: true,
      status: 200,
      body: {
        records: [
          { backupId: 'b-ok', startedAt: '2026-08-22T00:00:00Z', status: 'success' },
          // 未知/中间态（如 pending）：不应被伪装成 failure，而应跳过
          { backupId: 'b-pending', startedAt: '2026-08-22T00:01:00Z', status: 'pending' },
        ],
      },
    }));
    const adapter = new ExternalBackupAdapter({ endpoint: 'https://backup.example.com', fetchFn });
    const list = await adapter.recentBackups(5);
    assert.equal(list.length, 1);
    assert.equal(list[0]?.backupId, 'b-ok');
    assert.equal(list[0]?.status, 'success');
  });
});
