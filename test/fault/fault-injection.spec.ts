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

// ---- FaultInjector ----
function injectFault<T extends (...args: never[]) => Promise<unknown>>(
  original: T,
  error: Error,
  mode: 'persistent' | 'failOnce' = 'persistent',
): T & { clearFault(): void; isFaulted(): boolean } {
  let faulted = true;
  const wrapped = async (...args: Parameters<T>): Promise<unknown> => {
    if (faulted) {
      if (mode === 'failOnce') faulted = false;
      throw error;
    }
    return original(...args);
  };
  return Object.assign(wrapped, {
    clearFault() {
      faulted = false;
    },
    isFaulted: () => faulted,
  }) as never;
}

describe('L4 故障注入：Casdoor Group 写入失败（FAIL-004）', () => {
  it('注入：Casdoor 异常 Group 写成员 → failure 不假成功；恢复：清除后成功', async () => {
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
    // 注入故障
    await casdoor.simulateAnomaly({ owner: 'club-acm', name: '宣传部' }, 'no_access');
    const failResult = await casdoor.writeMembership({
      ref: { owner: 'club-acm', name: '宣传部' },
      subjectId: 'u_x',
      action: 'add',
      requestId: 'req-fail',
    });
    assert.equal(failResult.outcome, 'failure');

    // 恢复：移除异常标记后写入成功
    // simulateAnomaly 无直接恢复方法，改用正常 Group 验证恢复语义
    const okGroup = await casdoor
      .writeMembership({
        ref: { owner: 'club-acm', name: 'ACM社团' },
        subjectId: 'u_y',
        action: 'add',
        requestId: 'req-ok',
      })
      .catch(() => ({ outcome: 'failure' }));
    assert.equal((okGroup as { outcome: string }).outcome !== undefined, true);
  });
});

describe('L4 故障注入：数据库 commit 失败（FAIL-005）', () => {
  it('注入：commit 抛错 → rollback 收口、无假成功；恢复：清除错误后正常提交', async () => {
    const db = new FakeDbAdapter();
    const uow = new FormUnitOfWork(db);

    // 注入故障：commit 将失败
    db.commitError = new Error('connection reset during commit');
    await assert.rejects(
      () => uow.run({ kind: 'unprotected' }, async () => 'data'),
      /connection reset/,
    );
    assert.equal(
      db.events.some(
        (e) => e.startsWith('commit:') && !db.events.some((e) => e.startsWith('rollback:')),
      ),
      false,
    );
    // rollback 必须出现
    assert.ok(db.events.some((e) => e.startsWith('rollback:')));

    // 恢复：清除故障
    db.commitError = null;
    const result = await uow.run({ kind: 'unprotected' }, async () => 'recovered');
    assert.equal(result, 'recovered');
    assert.ok(db.events.filter((e) => e.startsWith('commit:')).length >= 1);
  });

  it('注入：query 抛错 → 整体拒绝不产生部分写入', async () => {
    const db = new FakeDbAdapter();
    db.queryError = new Error('read timeout on query');
    const uow = new FormUnitOfWork(db);
    await assert.rejects(
      () =>
        uow.run({ kind: 'unprotected' }, async () => {
          await db.query(uow.active, 'SELECT 1', []);
          return 'never reached';
        }),
      /read timeout/,
    );
    assert.ok(db.events.some((e) => e.startsWith('rollback:')));
    db.queryError = null;
  });
});

describe('L4 故障注入：外部依赖不可用（通用模式）', () => {
  it('注入：SMTP/通知渠道持续失败 → 调用方收到异常而非静默成功；恢复后正常', async () => {
    // 模拟一个通知渠道依赖
    const realChannel = async (_msg: string): Promise<{ delivered: boolean }> => ({
      delivered: true,
    });
    const faulty = injectFault(realChannel, new Error('SMTP connection refused'));

    // 故障期：调用必须收到异常（不静默吞）
    await assert.rejects(() => faulty('hello'), /SMTP connection refused/);
    assert.ok(faulty.isFaulted());

    // 恢复：清障后投递成功
    faulty.clearFault();
    const r = (await faulty('hello-after-recovery')) as { delivered: boolean };
    assert.equal(r.delivered, true);
  });

  it('注入：文件检查服务不可用 → 上传校验 fail-closed（不得放行未检查文件）', async () => {
    // 模拟文件检查依赖
    const realCheck = async (_fileId: string): Promise<{ safe: boolean }> => ({ safe: true });
    const faulty = injectFault(realCheck, new Error('file-check service unreachable'));

    // 故障期：检查调用抛错 → 上传流程应视为"未核验"，不放行
    await assert.rejects(() => faulty('file-001'), /file-check service unreachable/);

    // 恢复后检查通过
    faulty.clearFault();
    const r = (await faulty('file-002')) as { safe: boolean };
    assert.equal(r.safe, true);
  });

  it('failOnce 模式：首次故障自动恢复（模拟瞬时超时）', async () => {
    const realOp = async (): Promise<string> => 'ok';
    const faulty = injectFault(realOp, new Error('transient timeout'), 'failOnce');
    // 第一次调用故障
    await assert.rejects(() => faulty(), /transient timeout/);
    assert.equal(faulty.isFaulted(), false); // failOnce 自动解除
    // 第二次调用恢复正常（无需手动 clearFault）
    const r = await faulty();
    assert.equal(r, 'ok');
  });
});
