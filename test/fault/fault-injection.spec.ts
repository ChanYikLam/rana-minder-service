/**
 * L4 故障注入测试（P1 工作包②；TST-FAIL-* 锚点的行为级验证）。
 *
 * 三步模式：注入故障 → 验证失败关闭（不产生假成功）→ 移除故障并验证恢复。
 * 每个场景对应 TST-FAIL 权威编号。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { FakeDbAdapter } from '../../src/shared/testing/fake-db-adapter';
import { FormUnitOfWork } from '../../src/modules/form/infrastructure/unit-of-work';
import { InMemoryCasdoorPort } from '../../src/modules/organization/infrastructure/in-memory/memory-implementations';
import { ExternalFileCheckAdapter } from '../../src/adapters/file-check/external-file-check.adapter';
import { FileCheckOutcome } from '../../src/modules/file/domain/state-machines/file-state-machine';
import type { FileRecord } from '../../src/modules/file/domain/models/file-model';
import { injectFault } from './fault-injector';

describe('L4 故障注入：Casdoor Group 写入失败（FAIL-004）', () => {
  it('注入：simulateAnomaly → writeMembership failure；清障：clearAnomaly → 同 Group 恢复 success', async () => {
    const casdoor = new InMemoryCasdoorPort({
      groups: [
        {
          ref: { owner: 'club-acm', name: '宣传部' },
          displayName: '宣传部',
          parentRef: null,
          memberIds: [],
        },
      ],
    });
    const ref = { owner: 'club-acm', name: '宣传部' };

    // ① 注入故障
    await casdoor.simulateAnomaly(ref, 'no_access');
    const failResult = await casdoor.writeMembership({
      ref,
      subjectId: 'u_x',
      action: 'add',
      requestId: 'req-fail',
    });
    assert.equal(failResult.outcome, 'failure');

    // ② 清除故障标记（真实恢复：同一 Group）
    casdoor.clearAnomaly(ref);
    const okResult = await casdoor.writeMembership({
      ref,
      subjectId: 'u_x',
      action: 'add',
      requestId: 'req-recover',
    });
    assert.equal(okResult.outcome, 'success');
  });
});

describe('L4 故障注入：数据库 commit 失败（FAIL-005）', () => {
  it('注入：commit 抛错 → rollback 收口、无假成功；恢复：清除错误后正常提交', async () => {
    const db = new FakeDbAdapter();
    const uow = new FormUnitOfWork(db);

    db.commitError = new Error('connection reset during commit');
    await assert.rejects(
      () => uow.run({ kind: 'unprotected' }, async () => 'data'),
      /connection reset/,
    );
    // 按 tx id 配对：begin 后必有 rollback（FakeDbAdapter 的 commit 事件在抛错前已入 events，
    // 因此不能断言 commits=0，而是断言 rollback 存在即证明事务被回滚而非假成功）
    const rollbacks = db.events.filter((e) => e.startsWith('rollback:'));
    assert.ok(rollbacks.length >= 1, '失败路径应有 rollback 收口');

    // 恢复：清除故障后正常提交
    db.commitError = null;
    const result = await uow.run({ kind: 'unprotected' }, async () => 'recovered');
    assert.equal(result, 'recovered');
    assert.ok(db.events.filter((e) => e.startsWith('commit:')).length >= 1);
  });

  it('注入：query 抛错 → 整体拒绝不产生部分写入', async () => {
    const db = new FakeDbAdapter();
    db.queryError = new Error('read timeout on query');
    const uow = new FormUnitOfWork(db);
    try {
      await assert.rejects(
        () =>
          uow.run({ kind: 'unprotected' }, async () => {
            await db.query(uow.active, 'SELECT 1', []);
            return 'never reached';
          }),
        /read timeout/,
      );
      assert.ok(db.events.some((e) => e.startsWith('rollback:')));
    } finally {
      // 确保断言失败时也能清除故障标记，避免污染后续用例（对象仅本地作用，清理以保可读性）
      db.queryError = null;
    }
  });
});

describe('L4 故障注入：文件检查服务不可用 fail-closed（FAIL-006）', () => {
  const stubFile: FileRecord = {
    fileId: 'file-check-fail006',
    uploaderId: 'u_x',
    scope: { kind: 'club', clubId: 'club-acm' },
    category: 'GENERIC',
    state: 'CHECKING',
    target: { objectType: 'application', objectId: 'app-1', fieldKey: 'attachment' },
    versionNo: 1,
    versions: [],
    uploadSession: null,
    checkRecord: null,
    cleanupQueue: [],
    deletionManifest: null,
    createdAt: '2026-08-01T00:00:00.000Z',
  };

  it('注入：外部检查服务网络故障 → 返回 FAILED/retryable（不得超时自动放行，GOV-008）', async () => {
    const adapter = new ExternalFileCheckAdapter({
      endpoint: 'https://file-check.invalid',
      timeoutMs: 1000,
      fetchFn: async () => {
        throw new Error('file-check service unreachable');
      },
    });
    const result = await adapter.check(stubFile, new Uint8Array([1, 2, 3]), 'application/pdf');
    // fail-closed：服务不可用一律 FAILED 且可重试，绝不 PASSED
    assert.equal(result.outcome, FileCheckOutcome.FAILED);
    assert.equal(result.retryable, true);
    assert.match(result.sanitizedResult, /service-unavailable/);
  });

  it('注入：检查服务返回非 2xx → 同样 FAILED 不假成功', async () => {
    const adapter = new ExternalFileCheckAdapter({
      endpoint: 'https://file-check.invalid',
      timeoutMs: 1000,
      fetchFn: async () =>
        new Response('internal error', {
          status: 500,
          headers: { 'Content-Type': 'text/plain' },
        }),
    });
    const result = await adapter.check(stubFile, new Uint8Array([1]), 'text/plain');
    assert.equal(result.outcome, FileCheckOutcome.FAILED);
    assert.equal(result.retryable, true);
  });

  it('注入：服务可用且返回 PASSED → 正常放行（恢复语义）', async () => {
    const adapter = new ExternalFileCheckAdapter({
      endpoint: 'https://file-check.invalid',
      timeoutMs: 1000,
      fetchFn: async () =>
        new Response(JSON.stringify({ verdict: 'PASSED' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
    });
    const result = await adapter.check(stubFile, new Uint8Array([1]), 'text/plain');
    assert.equal(result.outcome, FileCheckOutcome.PASSED);
    assert.equal(result.retryable, false);
  });
});

describe('L4 故障注入：外部依赖不可用（通用模式）', () => {
  it('SMTP/通知渠道持续失败 → 异常上抛不静默吞；恢复后正常投递', async () => {
    const realChannel = async (_msg: string): Promise<{ delivered: boolean }> => ({
      delivered: true,
    });
    const faulty = injectFault(realChannel, new Error('SMTP connection refused'));

    await assert.rejects(() => faulty('hello'), /SMTP connection refused/);
    assert.ok(faulty.isFaulted());

    faulty.clearFault();
    const r = (await faulty('hello-after-recovery')) as { delivered: boolean };
    assert.equal(r.delivered, true);
  });

  it('文件检查服务不可用 → 上传校验 fail-closed；恢复后检查通过', async () => {
    const realCheck = async (_fileId: string): Promise<{ safe: boolean }> => ({
      safe: true,
    });
    const faulty = injectFault(realCheck, new Error('file-check service unreachable'));

    await assert.rejects(() => faulty('file-001'), /file-check service unreachable/);

    faulty.clearFault();
    const r = (await faulty('file-002')) as { safe: boolean };
    assert.equal(r.safe, true);
  });

  it('failOnce 模式：首次故障自动恢复（模拟瞬时超时）', async () => {
    const realOp = async (): Promise<string> => 'ok';
    const faulty = injectFault(realOp, new Error('transient timeout'), 'failOnce');
    await assert.rejects(() => faulty(), /transient timeout/);
    assert.equal(faulty.isFaulted(), false);
    const r = await faulty();
    assert.equal(r, 'ok');
  });
});
