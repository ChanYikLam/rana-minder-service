/**
 * Casdoor 字段映射单元测试（CFG-004，5.5.4；IDN-015）。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  REQUIRED_SYNC_FIELDS,
  SYNC_FIELD_WHITELIST,
  FieldMappingDraft,
  validateMappingEntries,
} from './field-mapping';
import type { FieldMappingEntry } from './field-mapping';

const NOW = new Date('2026-01-01T00:00:00Z');

function fullEntries(): FieldMappingEntry[] {
  return [
    { localField: 'STUDENT_ID', casdoorField: 'student_id', casdoorColumnType: 'string' },
    { localField: 'NAME', casdoorField: 'display_name', casdoorColumnType: 'string' },
    { localField: 'EMAIL', casdoorField: 'email', casdoorColumnType: 'string' },
  ];
}

describe('固定同步白名单（CFG-004/IDN-015）', () => {
  it('白名单六键与必需映射常量', () => {
    assert.deepEqual(SYNC_FIELD_WHITELIST, [
      'STUDENT_ID',
      'NAME',
      'COLLEGE',
      'GRADE',
      'EMAIL',
      'PHONE',
    ]);
    assert.deepEqual(REQUIRED_SYNC_FIELDS, ['STUDENT_ID', 'NAME']);
  });

  it('动态表单字段拒绝接入（IDN-015）', () => {
    assert.throws(
      () =>
        validateMappingEntries([
          {
            localField: 'dynamicForm:q1' as never,
            casdoorField: 'q1',
            casdoorColumnType: 'string',
          },
        ]),
      { code: 'CFG_VALIDATION' },
    );
    assert.throws(
      () =>
        validateMappingEntries([
          { localField: 'HACKED' as never, casdoorField: 'h', casdoorColumnType: 'string' },
        ]),
      { code: 'CFG_VALIDATION' },
    );
  });

  it('必需映射缺失拒绝（STUDENT_ID / NAME 各自验证）', () => {
    assert.throws(
      () =>
        validateMappingEntries([
          { localField: 'STUDENT_ID', casdoorField: 'sid', casdoorColumnType: 'string' },
        ]),
      { code: 'CFG_VALIDATION' },
    );
    assert.throws(
      () =>
        validateMappingEntries([
          { localField: 'NAME', casdoorField: 'name', casdoorColumnType: 'string' },
        ]),
      { code: 'CFG_VALIDATION' },
    );
  });

  it('重复 localField 拒绝；两个本地字段映射同一 Casdoor 字段拒绝（批量数据丢失风险）', () => {
    assert.throws(
      () =>
        validateMappingEntries([
          ...fullEntries(),
          { localField: 'STUDENT_ID', casdoorField: 'sid2', casdoorColumnType: 'string' },
        ]),
      { code: 'CFG_VALIDATION' },
    );
    assert.throws(
      () =>
        validateMappingEntries([
          ...fullEntries(),
          { localField: 'COLLEGE', casdoorField: 'email', casdoorColumnType: 'string' },
        ]),
      { code: 'CFG_VALIDATION' },
    );
  });

  it('casdoorField 非法命名拒绝：数字开头/连字符/超 64 字符', () => {
    const bad = (field: string) => [
      ...fullEntries(),
      { localField: 'COLLEGE' as const, casdoorField: field, casdoorColumnType: 'string' as const },
    ];
    assert.throws(() => validateMappingEntries(bad('9bad')), { code: 'CFG_VALIDATION' });
    assert.throws(() => validateMappingEntries(bad('a-b')), { code: 'CFG_VALIDATION' });
    assert.throws(() => validateMappingEntries(bad('x'.repeat(65))), { code: 'CFG_VALIDATION' });
  });

  it('类型不兼容拒绝：number/boolean 列（六个白名单字段语义均为字符串）', () => {
    assert.throws(
      () =>
        validateMappingEntries([
          ...fullEntries(),
          { localField: 'COLLEGE', casdoorField: 'college', casdoorColumnType: 'number' },
        ]),
      { code: 'CFG_VALIDATION' },
    );
    assert.throws(
      () =>
        validateMappingEntries([
          ...fullEntries(),
          { localField: 'GRADE', casdoorField: 'grade', casdoorColumnType: 'boolean' },
        ]),
      { code: 'CFG_VALIDATION' },
    );
  });

  it('规范化输出按白名单顺序排序', () => {
    const normalized = validateMappingEntries([
      { localField: 'EMAIL', casdoorField: 'email', casdoorColumnType: 'string' },
      { localField: 'NAME', casdoorField: 'display_name', casdoorColumnType: 'string' },
      { localField: 'STUDENT_ID', casdoorField: 'student_id', casdoorColumnType: 'string' },
    ]);
    assert.deepEqual(
      normalized.map((e) => e.localField),
      ['STUDENT_ID', 'NAME', 'EMAIL'],
    );
  });
});

describe('FieldMappingDraft 编辑态（CFG-004）', () => {
  it('setEntries 合法替换：revisionNumber+1、updatedBy/updatedAt 更新', () => {
    const draft = FieldMappingDraft.create(fullEntries(), { by: 'sa', now: NOW });
    const later = new Date('2026-01-02T00:00:00Z');
    draft.setEntries(
      [
        ...fullEntries(),
        { localField: 'COLLEGE', casdoorField: 'college', casdoorColumnType: 'string' },
      ],
      { by: 'sa', now: later },
    );
    assert.equal(draft.entries.length, 4);
    assert.equal(draft.revisionNumber, 2);
    assert.equal(draft.updatedBy, 'sa');
    assert.deepEqual(draft.updatedAt, later);
  });

  it('任何时刻缺必需映射的写入都被拦截（validateMappingEntries 强制）', () => {
    const draft = FieldMappingDraft.create(fullEntries(), { by: 'sa', now: NOW });
    assert.throws(
      () =>
        draft.setEntries(
          [{ localField: 'EMAIL', casdoorField: 'e', casdoorColumnType: 'string' }],
          {
            by: 'sa',
            now: NOW,
          },
        ),
      { code: 'CFG_VALIDATION' },
    );
  });

  it('activateRealData 置位成功；置位后删除必需映射仍被两道守卫阻止', () => {
    const draft = FieldMappingDraft.create(fullEntries(), { by: 'sa', now: NOW });
    draft.activateRealData({ by: 'sa', now: NOW });
    assert.equal(draft.realDataActivated, true);

    // setEntries 路径：validateMappingEntries 先挡
    assert.throws(
      () =>
        draft.setEntries(
          [{ localField: 'EMAIL', casdoorField: 'e', casdoorColumnType: 'string' }],
          { by: 'sa', now: NOW },
        ),
      { code: 'CFG_VALIDATION' },
    );

    // fromSnapshot 构造出缺必需的历史状态时，assertRequiredFieldsIntact 兜底（真实数据场景 CFG_PRECONDITION）
    assert.throws(
      () =>
        validateMappingEntries([
          { localField: 'EMAIL', casdoorField: 'e', casdoorColumnType: 'string' },
        ]) /* 缺必需 → CFG_VALIDATION */,
      { code: 'CFG_VALIDATION' },
    );
    const restored = FieldMappingDraft.fromSnapshot({
      entries: [{ localField: 'EMAIL', casdoorField: 'e', casdoorColumnType: 'string' }],
      realDataActivated: true,
      revisionNumber: 1,
      updatedBy: null,
      updatedAt: NOW,
    });
    // 直接以非法快照恢复后，发布门兜底校验同样拦截
    assert.throws(
      () =>
        restored.validateForPublish({
          testResultRef: 't-1',
          impactPreview: { affectedFields: [], estimatedUserCount: 0 },
        }),
      { code: 'CFG_VALIDATION' },
    );
  });
});

describe('发布门禁 validateForPublish（CFG-004 发布安全）', () => {
  function newDraft(): FieldMappingDraft {
    return FieldMappingDraft.create(fullEntries(), { by: 'sa', now: NOW });
  }

  it('无测试凭证 → CFG_PRECONDITION（发布前须测试实际 Casdoor 接口）', () => {
    const draft = newDraft();
    assert.throws(
      () =>
        draft.validateForPublish({
          testResultRef: null,
          impactPreview: { affectedFields: ['STUDENT_ID'], estimatedUserCount: 100 },
        }),
      { code: 'CFG_PRECONDITION' },
    );
    assert.throws(
      () =>
        draft.validateForPublish({
          testResultRef: '   ',
          impactPreview: { affectedFields: ['STUDENT_ID'], estimatedUserCount: 100 },
        }),
      { code: 'CFG_PRECONDITION' },
    );
  });

  it('无影响预览或用户数为负 → CFG_PRECONDITION（发布前须预览受影响字段与用户数）', () => {
    const draft = newDraft();
    assert.throws(() => draft.validateForPublish({ testResultRef: 't-1', impactPreview: null }), {
      code: 'CFG_PRECONDITION',
    });
    assert.throws(
      () =>
        draft.validateForPublish({
          testResultRef: 't-1',
          impactPreview: { affectedFields: ['STUDENT_ID'], estimatedUserCount: -1 },
        }),
      { code: 'CFG_PRECONDITION' },
    );
  });

  it('齐备 → ok + reconciliationRequired=true（发布后执行一次受控对账）', () => {
    const draft = newDraft();
    const result = draft.validateForPublish({
      testResultRef: 'test-run-42',
      impactPreview: { affectedFields: ['STUDENT_ID', 'NAME', 'EMAIL'], estimatedUserCount: 1234 },
    });
    assert.deepEqual(result, { ok: true, reconciliationRequired: true });
  });
});

describe('快照往返（fromSnapshot/toSnapshot）', () => {
  it('往返后状态一致且可继续编辑', () => {
    const draft = FieldMappingDraft.create(fullEntries(), { by: 'sa', now: NOW });
    draft.activateRealData({ by: 'sa', now: NOW });
    const restored = FieldMappingDraft.fromSnapshot(draft.toSnapshot());

    assert.deepEqual(restored.toSnapshot(), draft.toSnapshot());
    restored.setEntries(
      [
        ...fullEntries(),
        { localField: 'PHONE', casdoorField: 'phone', casdoorColumnType: 'string' },
      ],
      { by: 'sa', now: NOW },
    );
    assert.equal(restored.entries.length, 4);
    assert.equal(restored.realDataActivated, true);
  });
});
