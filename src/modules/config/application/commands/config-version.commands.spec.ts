/**
 * 配置版本线命令应用层测试（CFG-005，5.5.5；桩端口）。
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  InMemoryConfigRootRepository,
  RecordingConfigNotification,
  StubPolicyAuthorization,
} from '../testing/config-test-support';
import type { ConfigRootSnapshot } from '../../domain/models/config-version';
import {
  CreateConfigDraftCommand,
  EditConfigDraftCommand,
  GetConfigRootQuery,
  PublishConfigVersionCommand,
  RollbackConfigVersionCommand,
} from './config-version.commands';

const NOW = new Date('2026-01-01T00:00:00Z');
const LATER = new Date('2026-01-02T00:00:00Z');
const SA = 'super-1';
const ROOT = 'platform_policy';

describe('配置版本线命令（CFG-005）', () => {
  let repo: InMemoryConfigRootRepository;
  let auth: StubPolicyAuthorization;
  let notify: RecordingConfigNotification;
  /** 命令层事务包装桩：无外层事务时 runShared 直接执行回调（事务语义在集成层验证） */
  const uow = {
    active: null,
    runShared: async <T>(_scope: unknown, fn: () => Promise<T>): Promise<T> => fn(),
  };

  beforeEach(() => {
    repo = new InMemoryConfigRootRepository();
    auth = new StubPolicyAuthorization();
    notify = new RecordingConfigNotification();
    auth.platformAllowed = true;
  });

  it('非超管全部拒绝（fail-closed）', async () => {
    auth.platformAllowed = false;
    await assert.rejects(
      () =>
        new CreateConfigDraftCommand(repo, auth, notify, uow).execute({
          rootId: ROOT,
          kind: 'PLATFORM_POLICY',
          subjectId: 'x',
          now: NOW,
        }),
      { code: 'CFG_FORBIDDEN' },
    );
    await assert.rejects(
      () => new GetConfigRootQuery(repo, auth, notify, uow).execute({ rootId: ROOT, subjectId: 'x' }),
      { code: 'CFG_FORBIDDEN' },
    );
  });

  it('创建草稿→编辑→发布（低风险免确认）全链路；版本只增不删', async () => {
    const create = new CreateConfigDraftCommand(repo, auth, notify, uow);
    const edit = new EditConfigDraftCommand(repo, auth, notify, uow);
    const publish = new PublishConfigVersionCommand(repo, auth, notify, uow);

    const draftResult = await create.execute({
      rootId: ROOT,
      kind: 'PLATFORM_POLICY',
      subjectId: SA,
      now: NOW,
    });
    assert.equal(draftResult.latestDraft.versionNumber, 1);
    assert.equal(draftResult.latestDraft.state, 'DRAFT');

    await edit.execute({
      rootId: ROOT,
      versionNumber: 1,
      subjectId: SA,
      now: NOW,
      payload: { a: 1 },
    });
    const published = await publish.execute({
      rootId: ROOT,
      versionNumber: 1,
      subjectId: SA,
      now: LATER,
      testResultRef: 't-1',
    });
    assert.equal(published.currentPublishedVersionNumber, 1);

    // 修改=新版本
    await create.execute({ rootId: ROOT, kind: 'PLATFORM_POLICY', subjectId: SA, now: LATER });
    await edit.execute({
      rootId: ROOT,
      versionNumber: 2,
      subjectId: SA,
      now: LATER,
      payload: { a: 2 },
    });
    const snap = (await repo.find(ROOT))!;
    assert.equal(snap.versions.length, 2);
    assert.equal(snap.versions[0].payload.a, 1);
  });

  it('发布缺测试凭证 → CFG_VALIDATION（markTestPassed 空串拒绝）', async () => {
    await new CreateConfigDraftCommand(repo, auth, notify, uow).execute({
      rootId: ROOT,
      kind: 'PLATFORM_POLICY',
      subjectId: SA,
      now: NOW,
    });
    await assert.rejects(
      () =>
        new PublishConfigVersionCommand(repo, auth, notify, uow).execute({
          rootId: ROOT,
          versionNumber: 1,
          subjectId: SA,
          now: NOW,
          testResultRef: '',
        }),
      { code: 'CFG_VALIDATION' },
    );
  });

  it('回滚：基于旧发布版本建新草稿并保留完整历史', async () => {
    const create = new CreateConfigDraftCommand(repo, auth, notify, uow);
    const edit = new EditConfigDraftCommand(repo, auth, notify, uow);
    const publish = new PublishConfigVersionCommand(repo, auth, notify, uow);

    await create.execute({ rootId: ROOT, kind: 'PLATFORM_POLICY', subjectId: SA, now: NOW });
    await edit.execute({
      rootId: ROOT,
      versionNumber: 1,
      subjectId: SA,
      now: NOW,
      payload: { v: 1 },
    });
    await publish.execute({
      rootId: ROOT,
      versionNumber: 1,
      subjectId: SA,
      now: NOW,
      testResultRef: 't',
    });

    await create.execute({ rootId: ROOT, kind: 'PLATFORM_POLICY', subjectId: SA, now: LATER });
    await edit.execute({
      rootId: ROOT,
      versionNumber: 2,
      subjectId: SA,
      now: LATER,
      payload: { v: 2 },
    });
    await publish.execute({
      rootId: ROOT,
      versionNumber: 2,
      subjectId: SA,
      now: LATER,
      testResultRef: 't2',
    });

    const rolled = await new RollbackConfigVersionCommand(repo, auth, notify, uow).execute({
      rootId: ROOT,
      sourceVersionNumber: 1,
      subjectId: SA,
      now: LATER,
    });
    assert.equal(rolled.draft.versionNumber, 3);
    assert.equal((rolled.draft.payload as { v: number }).v, 1);

    const snap = (await repo.find(ROOT))!;
    assert.equal(snap.versions.length, 3);
    assert.equal(snap.currentPublishedVersionNumber, 2);
  });

  it('GetConfigRootQuery 返回完整版本线；不存在 CFG_NOT_FOUND', async () => {
    await new CreateConfigDraftCommand(repo, auth, notify, uow).execute({
      rootId: ROOT,
      kind: 'PLATFORM_POLICY',
      subjectId: SA,
      now: NOW,
    });
    const snap = await new GetConfigRootQuery(repo, auth, notify, uow).execute({
      rootId: ROOT,
      subjectId: SA,
    });
    assert.equal(snap.kind, 'PLATFORM_POLICY');

    await assert.rejects(
      () => new GetConfigRootQuery(repo, auth, notify, uow).execute({ rootId: 'ghost', subjectId: SA }),
      { code: 'CFG_NOT_FOUND' },
    );
  });

  it('同一 rootId 不能以不同种类复用', async () => {
    await new CreateConfigDraftCommand(repo, auth, notify, uow).execute({
      rootId: ROOT,
      kind: 'PLATFORM_POLICY',
      subjectId: SA,
      now: NOW,
    });
    await assert.rejects(
      () =>
        new CreateConfigDraftCommand(repo, auth, notify, uow).execute({
          rootId: ROOT,
          kind: 'FORM_TEMPLATE',
          subjectId: SA,
          now: NOW,
        }),
      { code: 'CFG_CONFLICT' },
    );
  });

  it('写操作在单一事务窗口内执行读-改-写（CFG-005 并发保护 Critical 修复）', async () => {
    let forUpdateCalls = 0;
    let repoCallsInTx = 0;
    let inTx = false;
    // 模拟命令层事务包裹：runShared 进入回调视为事务窗口开启（行锁须持至回调结束）
    const txUow = {
      active: null,
      runShared: async <T>(_scope: unknown, fn: () => Promise<T>): Promise<T> => {
        inTx = true;
        try {
          return await fn();
        } finally {
          inTx = false;
        }
      },
    };
    const trackingRepo = new (class extends InMemoryConfigRootRepository {
      override async findForUpdate(rootId: string) {
        forUpdateCalls++;
        if (inTx) repoCallsInTx++;
        return super.findForUpdate(rootId);
      }
      override async save(snapshot: ConfigRootSnapshot) {
        if (inTx) repoCallsInTx++;
        return super.save(snapshot);
      }
    })();
    const create = new CreateConfigDraftCommand(trackingRepo, auth, notify, txUow);
    const edit = new EditConfigDraftCommand(trackingRepo, auth, notify, txUow);
    const publish = new PublishConfigVersionCommand(trackingRepo, auth, notify, txUow);
    const rollback = new RollbackConfigVersionCommand(trackingRepo, auth, notify, txUow);

    await create.execute({ rootId: ROOT, kind: 'PLATFORM_POLICY', subjectId: SA, now: NOW });
    await edit.execute({
      rootId: ROOT,
      versionNumber: 1,
      subjectId: SA,
      now: NOW,
      payload: { a: 1 },
    });
    await publish.execute({
      rootId: ROOT,
      versionNumber: 1,
      subjectId: SA,
      now: NOW,
      testResultRef: 't-1',
    });
    await rollback.execute({ rootId: ROOT, sourceVersionNumber: 1, subjectId: SA, now: NOW });

    assert.equal(forUpdateCalls, 4, '四个写命令都必须加锁读根（串行化并发版本操作）');
    assert.equal(
      repoCallsInTx,
      8,
      'findForUpdate+save 必须全部在命令自开的事务窗口内执行（锁不随独立事务释放）',
    );
  });
});
