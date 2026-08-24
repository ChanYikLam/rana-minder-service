/**
 * 外部文件检查适配器单测（P2 零覆盖补测；IFC-FIL-002/003、GOV-008）。
 *
 * 关键语义：verdict 三值映射（PASSED/QUARANTINED/其他→FAILED 可重试）；
 * 非 2xx 与超时 → UNAVAILABLE 语义（FAILED+retryable，保持检查中，不得放行）。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { ExternalFileCheckAdapter } from './external-file-check.adapter';
import { FileCheckOutcome } from '../../modules/file/domain/state-machines/file-state-machine';
import type { FileRecord } from '../../modules/file/domain/models/file-model';

function makeFile(): FileRecord {
  return {
    fileId: 'file-syn-1',
    uploaderId: 'SYN-U-1',
    scope: { kind: 'CLUB', clubId: 'club-1' },
    category: 'attachment' as FileRecord['category'],
    state: 'checking' as FileRecord['state'],
    target: null,
  } as unknown as FileRecord;
}

function makeAdapter(
  responder: (url: string, init: RequestInit) => { status: number; body: unknown },
): { adapter: ExternalFileCheckAdapter; calls: Array<{ url: string; init: RequestInit }> } {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchFn = (async (input: string | URL, init: RequestInit = {}) => {
    const url = typeof input === 'string' ? input : String(input);
    calls.push({ url, init });
    const r = responder(url, init);
    return new Response(JSON.stringify(r.body), { status: r.status });
  }) as typeof fetch;
  return {
    adapter: new ExternalFileCheckAdapter({
      endpoint: 'https://fcheck.example.com',
      token: 'tk',
      fetchFn,
    }),
    calls,
  };
}

describe('ExternalFileCheckAdapter', () => {
  it('PASSED verdict → PASSED（不可重试）', async () => {
    const { adapter } = makeAdapter(() => ({ status: 200, body: { verdict: 'PASSED' } }));
    const r = await adapter.check(makeFile(), new Uint8Array([1]), 'application/pdf');
    assert.equal(r.outcome, FileCheckOutcome.PASSED);
    assert.equal(r.retryable, false);
    assert.equal(r.sanitizedResult, 'external-pass');
  });

  it('QUARANTINED verdict → QUARANTINED', async () => {
    const { adapter } = makeAdapter(() => ({ status: 200, body: { verdict: 'QUARANTINED' } }));
    const r = await adapter.check(makeFile(), new Uint8Array([1]), 'application/pdf');
    assert.equal(r.outcome, FileCheckOutcome.QUARANTINED);
    assert.equal(r.retryable, false);
  });

  it('未知 verdict → FAILED 且可重试（不猜测、不放行）', async () => {
    const { adapter } = makeAdapter(() => ({ status: 200, body: { verdict: 'WEIRD' } }));
    const r = await adapter.check(makeFile(), new Uint8Array([1]), 'application/pdf');
    assert.equal(r.outcome, FileCheckOutcome.FAILED);
    assert.equal(r.retryable, true);
    assert.ok(r.sanitizedResult.includes('external-unknown-verdict'));
  });

  it('非 2xx → FAILED+retryable（服务不可用语义，保持检查中）', async () => {
    const { adapter } = makeAdapter(() => ({ status: 503, body: {} }));
    const r = await adapter.check(makeFile(), new Uint8Array([1]), 'application/pdf');
    assert.equal(r.outcome, FileCheckOutcome.FAILED);
    assert.equal(r.retryable, true);
    assert.ok(r.sanitizedResult.startsWith('service-unavailable:'));
  });

  it('网络异常 → 同不可用语义（脱敏摘要）', async () => {
    const fetchFn = (async () => {
      throw new Error('ECONNRESET');
    }) as typeof fetch;
    const adapter = new ExternalFileCheckAdapter({ endpoint: 'https://x', fetchFn });
    const r = await adapter.check(makeFile(), new Uint8Array([1]), 'application/pdf');
    assert.equal(r.outcome, FileCheckOutcome.FAILED);
    assert.equal(r.retryable, true);
  });

  it('请求头携带声明类型与文件 ID + Bearer token', async () => {
    const { adapter, calls } = makeAdapter(() => ({ status: 200, body: { verdict: 'PASSED' } }));
    await adapter.check(makeFile(), new Uint8Array([1]), 'image/png');
    const headers = calls[0]?.init.headers as Record<string, string>;
    assert.equal(headers['X-Declared-Type'], 'image/png');
    assert.equal(headers['X-File-Id'], 'file-syn-1');
    assert.equal(headers['Authorization'], 'Bearer tk');
  });
});
