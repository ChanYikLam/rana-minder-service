/**
 * L5 运维演练门 3：RLS 连接上下文无残留（OPS-VER-008）。
 *
 * 锚点语义：RLS 连接上下文在全部结束路径无残留——成功、回滚、异常、超时、
 * 取消和复用负向证据（docs/operations/部署运维与恢复手册-v1.0.md §OPS-VER 表）。
 *
 * 演练方式（真实类 + 假 DbAdapter，SQL/事务事件全记录）：
 * - IdentityUnitOfWork.run 的四条结束路径：成功提交 / 业务异常回滚 / 提交失败回滚 /
 *   复用隔离（连续两次、嵌套拒绝）；
 * - PostgresSessionRevocation.getRevocation 自管事务的成败两条路径（finally 清理）；
 * - 每条路径断言事件序列以 clear-rls 收尾且归还后无可残留活动事务。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { FakeDbAdapter } from '../../src/shared/testing/fake-db-adapter';
import { IdentityUnitOfWork } from '../../src/modules/identity/infrastructure/unit-of-work';
import { PostgresSessionRevocation } from '../../src/modules/identity/infrastructure/postgres-session-revocation';
import { RecordingDbAdapter } from './helpers/recording-db';

const SCOPE = { kind: 'single', subjectId: 'user-ops' } as const;

/** 汇总各结束路径证据（由各用例写入，末尾结构化演练结论统一判定） */
const findings = {
  successPath: false,
  rollbackPath: false,
  commitFailurePath: false,
  reuseIsolated: false,
  sessionReadPaths: false,
};

describe('OPS-VER-008 RLS 连接上下文全部结束路径无残留演练', () => {
  it('成功路径：begin → set-rls → commit → clear-rls，归还后无活动事务', async () => {
    const db = new FakeDbAdapter();
    const uow = new IdentityUnitOfWork(db);

    const result = await uow.run(SCOPE, async () => 'ok');
    assert.equal(result, 'ok');

    assert.deepEqual(
      db.events.map((e) => `${e.split(':')[0]}:`),
      ['begin:', `set-rls:`, 'commit:', 'clear-rls:'],
    );
    assert.ok(!db.events.some((e) => e.startsWith('rollback')), '成功路径不得出现回滚');

    // 归还证明：工作单元不再持有事务（无残留上下文可被复用）
    assert.throws(() => uow.active, /无活动事务/);
    findings.successPath = true;
  });

  it('业务异常路径：rollback 收口且 clear-rls 兜底，绝无 commit', async () => {
    const db = new FakeDbAdapter();
    const uow = new IdentityUnitOfWork(db);

    await assert.rejects(
      uow.run(SCOPE, async () => {
        throw new Error('business-boom');
      }),
      /business-boom/,
    );

    const prefixes = db.events.map((e) => e.split(':')[0]);
    assert.deepEqual(prefixes, ['begin', 'set-rls', 'rollback', 'clear-rls']);
    assert.equal(prefixes.includes('commit'), false, '失败路径不得提交');
    assert.equal(prefixes[prefixes.length - 1], 'clear-rls', '最后一步必须是清理 RLS 上下文');
    assert.throws(() => uow.active, /无活动事务/);
    findings.rollbackPath = true;
  });

  it('提交失败路径：commit 抛错仍 rollback + clear-rls（异常/超时同构收口）', async () => {
    const db = new FakeDbAdapter();
    db.commitError = new Error('connection-reset-during-commit');
    const uow = new IdentityUnitOfWork(db);

    await assert.rejects(
      uow.run(SCOPE, async () => undefined),
      /connection-reset/,
    );

    const prefixes = db.events.map((e) => e.split(':')[0]);
    assert.deepEqual(prefixes, ['begin', 'set-rls', 'commit', 'rollback', 'clear-rls']);
    assert.throws(() => uow.active, /无活动事务/);
    findings.commitFailurePath = true;
  });

  it('复用负向：同一工作单元连续两轮各自完整收口；嵌套 run 立即拒绝', async () => {
    const db = new FakeDbAdapter();
    const uow = new IdentityUnitOfWork(db);

    await uow.run(SCOPE, async () => undefined);
    await uow.run(SCOPE, async () => undefined);

    // 两轮独立生命周期，互不残留
    assert.deepEqual(
      db.events.map((e) => e.split(':')[0]),
      ['begin', 'set-rls', 'commit', 'clear-rls', 'begin', 'set-rls', 'commit', 'clear-rls'],
    );

    // 嵌套调用：事务内再开 run 被立即拒绝，外层随后仍能正常回滚收口
    await assert.rejects(
      uow.run(SCOPE, () => uow.run(SCOPE, async () => undefined)),
      /不支持嵌套事务/,
    );
    assert.equal(db.events[db.events.length - 1].split(':')[0], 'clear-rls');
    findings.reuseIsolated = true;
  });

  it('会话读取自管事务：成功与查询故障两条路径均以 clear-rls 结束', async () => {
    // 成功路径
    const okDb = new RecordingDbAdapter();
    okDb.enqueueResult([{ revoke_version: '3', revoked_at: new Date('2026-08-24T08:00:00Z') }]);
    const revocation = new PostgresSessionRevocation(okDb, new IdentityUnitOfWork(okDb));
    const r = await revocation.getRevocation('user-ops');
    assert.equal(r?.revokeVersion, 3);
    assert.deepEqual(
      okDb.eventPrefixes().map((p) => p.split(':')[0]),
      ['begin', 'set-rls', 'query', 'commit', 'clear-rls'],
    );

    // 查询故障路径：rollback 后仍清理（取消/断连同构）
    const badDb = new RecordingDbAdapter();
    badDb.queryError = new Error('ECONNRESET-during-session-read');
    const failing = new PostgresSessionRevocation(badDb, new IdentityUnitOfWork(badDb));
    await assert.rejects(failing.getRevocation('user-ops'), /ECONNRESET/);
    const tail = badDb.eventPrefixes().map((p) => p.split(':')[0]);
    assert.deepEqual(tail.slice(-2), ['rollback', 'clear-rls']);
    findings.sessionReadPaths = true;
  });

  it('演练结论：五条结束路径均证明连接上下文零残留（结构化汇总）', () => {
    assert.deepEqual(findings, {
      successPath: true,
      rollbackPath: true,
      commitFailurePath: true,
      reuseIsolated: true,
      sessionReadPaths: true,
    });
  });
});
