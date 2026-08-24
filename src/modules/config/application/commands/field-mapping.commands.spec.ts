/**
 * Casdoor 字段映射命令应用层测试（CFG-004，5.5.4；桩端口）。
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  InMemoryConfigRootRepository,
  InMemoryFieldMappingStateRepository,
  RecordingConfigNotification,
  StubPolicyAuthorization,
} from '../testing/config-test-support';
import {
  ActivateFieldMappingRealDataCommand,
  FIELD_MAPPING_ROOT_ID,
  GetFieldMappingQuery,
  PublishFieldMappingCommand,
  SaveFieldMappingDraftCommand,
} from './field-mapping.commands';

const NOW = new Date('2026-01-01T00:00:00Z');
const LATER = new Date('2026-01-02T00:00:00Z');
const SA = 'super-1';

function entries() {
  return [
    {
      localField: 'STUDENT_ID' as const,
      casdoorField: 'student_id',
      casdoorColumnType: 'string' as const,
    },
    {
      localField: 'NAME' as const,
      casdoorField: 'display_name',
      casdoorColumnType: 'string' as const,
    },
  ];
}

describe('字段映射命令（CFG-004）', () => {
  let states: InMemoryFieldMappingStateRepository;
  let roots: InMemoryConfigRootRepository;
  let auth: StubPolicyAuthorization;
  let notify: RecordingConfigNotification;

  beforeEach(() => {
    states = new InMemoryFieldMappingStateRepository();
    roots = new InMemoryConfigRootRepository();
    auth = new StubPolicyAuthorization();
    notify = new RecordingConfigNotification();
    auth.platformAllowed = true;
  });

  it('非超管保存/发布/查看全部拒绝', async () => {
    auth.platformAllowed = false;
    await assert.rejects(
      () =>
        new SaveFieldMappingDraftCommand(states, auth).execute({
          subjectId: SA,
          now: NOW,
          entries: entries(),
        }),
      { code: 'CFG_FORBIDDEN' },
    );
    await assert.rejects(
      () =>
        new PublishFieldMappingCommand(states, roots, auth, notify).execute({
          subjectId: SA,
          now: NOW,
          testResultRef: 't',
          impactPreview: { affectedFields: ['STUDENT_ID'], estimatedUserCount: 1 },
          impactSummary: 's',
          confirmation: 'CONFIRMED',
        }),
      { code: 'CFG_FORBIDDEN' },
    );
    await assert.rejects(() => new GetFieldMappingQuery(states, auth).execute({ subjectId: SA }), {
      code: 'CFG_FORBIDDEN',
    });
  });

  it('草稿保存：首次创建+整体替换 bump revision；非法条目拒绝且不落库', async () => {
    const save = new SaveFieldMappingDraftCommand(states, auth);
    const first = await save.execute({ subjectId: SA, now: NOW, entries: entries() });
    assert.equal(first.state.revisionNumber, 1);

    const second = await save.execute({
      subjectId: SA,
      now: LATER,
      entries: [
        ...entries(),
        {
          localField: 'EMAIL' as const,
          casdoorField: 'email',
          casdoorColumnType: 'string' as const,
        },
      ],
    });
    assert.equal(second.state.revisionNumber, 2);
    assert.equal(second.state.entries.length, 3);

    // 缺必需映射的写入被拒且不落库（原状=上一版 3 条映射）
    await assert.rejects(() => save.execute({ subjectId: SA, now: LATER, entries: [] }), {
      code: 'CFG_VALIDATION',
    });
    assert.equal((await states.load())!.entries.length, 3);
  });

  it('activateRealData：草稿不存在拒绝；存在时置位', async () => {
    const activate = new ActivateFieldMappingRealDataCommand(states, auth);
    await assert.rejects(() => activate.execute({ subjectId: SA, now: NOW }), {
      code: 'CFG_PRECONDITION',
    });

    await new SaveFieldMappingDraftCommand(states, auth).execute({
      subjectId: SA,
      now: NOW,
      entries: entries(),
    });
    const result = await activate.execute({ subjectId: SA, now: NOW });
    assert.equal(result.state.realDataActivated, true);
  });

  it('发布链路：门禁缺一不可 → 版本线 PUBLISHED + 对账标记 + 历史完整', async () => {
    const save = new SaveFieldMappingDraftCommand(states, auth);
    const publish = new PublishFieldMappingCommand(states, roots, auth, notify);

    await save.execute({ subjectId: SA, now: NOW, entries: entries() });

    // 无测试凭证 → CFG_PRECONDITION
    await assert.rejects(
      () =>
        publish.execute({
          subjectId: SA,
          now: NOW,
          testResultRef: '',
          impactPreview: { affectedFields: ['STUDENT_ID'], estimatedUserCount: 10 },
          impactSummary: '影响全部学生资料同步',
          confirmation: 'CONFIRMED',
        }),
      { code: 'CFG_PRECONDITION' },
    );

    // 高风险未二次确认 → CFG_PRECONDITION（版本线聚合强制）
    await assert.rejects(
      () =>
        publish.execute({
          subjectId: SA,
          now: NOW,
          testResultRef: 'casdoor-test-42',
          impactPreview: { affectedFields: ['STUDENT_ID', 'NAME'], estimatedUserCount: 1200 },
          impactSummary: '影响全部学生资料同步',
          confirmation: 'OK',
        }),
      { code: 'CFG_PRECONDITION' },
    );

    // 齐备 → 发布成功
    const result = await publish.execute({
      subjectId: SA,
      now: LATER,
      testResultRef: 'casdoor-test-42',
      impactPreview: { affectedFields: ['STUDENT_ID', 'NAME'], estimatedUserCount: 1200 },
      impactSummary: '影响全部学生资料同步（约 1200 人）',
      confirmation: 'CONFIRMED',
    });
    assert.equal(result.publishedVersionNumber, 1);
    assert.equal(result.reconciliationRequired, true);

    // 二次发布 → 新版本（基于 v1 回滚语义建新草稿）
    await save.execute({
      subjectId: SA,
      now: LATER,
      entries: [
        ...entries(),
        {
          localField: 'PHONE' as const,
          casdoorField: 'phone',
          casdoorColumnType: 'string' as const,
        },
      ],
    });
    const second = await publish.execute({
      subjectId: SA,
      now: LATER,
      testResultRef: 'casdoor-test-43',
      impactPreview: { affectedFields: ['STUDENT_ID', 'NAME', 'PHONE'], estimatedUserCount: 1300 },
      impactSummary: '新增手机号同步',
      confirmation: 'CONFIRMED',
    });
    assert.equal(second.publishedVersionNumber, 2);

    // 发布通知接缝断言
    assert.deepEqual(
      notify.published.map((x) => x.versionNumber),
      [1, 2],
    );

    const rootSnap = (await roots.find(FIELD_MAPPING_ROOT_ID))!;
    assert.equal(rootSnap.kind, 'FIELD_MAPPING');
    assert.equal(rootSnap.versions.length, 2);
    assert.equal(rootSnap.currentPublishedVersionNumber, 2);
    assert.equal((rootSnap.versions[0].payload as { entries: unknown[] }).entries.length, 2);
  });

  it('草稿不存在时发布拒绝（CFG_PRECONDITION）', async () => {
    await assert.rejects(
      () =>
        new PublishFieldMappingCommand(states, roots, auth, notify).execute({
          subjectId: SA,
          now: NOW,
          testResultRef: 't',
          impactPreview: { affectedFields: [], estimatedUserCount: 0 },
          impactSummary: 's',
          confirmation: 'CONFIRMED',
        }),
      { code: 'CFG_PRECONDITION' },
    );
  });
});
