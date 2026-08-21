/**
 * FormSubmissionController（传输中立）集成测试（FORM-002）。
 *
 * 用内存仓储 + 桩权限 + FormUnitOfWork（FakeDbAdapter）跑完整控制器路径，
 * 验证信封结果结构、提交/列表/修订、权限失败关闭、幂等。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { FakeDbAdapter } from '../../../../shared/testing/fake-db-adapter';
import { FormUnitOfWork } from '../../infrastructure/unit-of-work';
import { FormSubmissionController } from './form-submission.controller';
import { DefaultSubmitFormUseCase } from '../../application/commands/submit-form.use-case';
import { DefaultReviseSubmissionUseCase } from '../../application/commands/revise-submission.use-case';
import { DefaultListSubmissionsQuery } from '../../application/queries/list-submissions.query';
import {
  InMemoryFormSubmissionRepository,
  InMemoryFormDefinitionRepository,
  InMemoryFormIdempotencyStore,
  StubFormFillPermission,
  StubFormAudit,
} from '../../application/testing/form-test-support';
import { formScopeOf } from '../../domain/models/form-scope';
import type { FormVersionSnapshot } from '../../domain/models/form-version';

const NOW = new Date('2026-08-21T09:00:00.000Z');
const SCOPE = formScopeOf('club', 'c1');
const ACTOR = { subjectId: 'u-1', now: NOW, traceId: 'trace-1' } as const;

function publishedVersion(formId: string, versionNumber: number): FormVersionSnapshot {
  return {
    id: `${formId}@v${versionNumber}`,
    formId,
    versionNumber,
    status: 'PUBLISHED',
    fields: [
      {
        id: 'name',
        title: '姓名',
        type: 'text',
        required: true,
        permission: 'read_write',
        validation: {},
      },
    ],
    rootVersion: 1,
    createdAt: NOW,
    publishedAt: NOW,
  } as unknown as FormVersionSnapshot;
}

function build(fill = new StubFormFillPermission()) {
  fill.allowed = true;
  const uow = new FormUnitOfWork(new FakeDbAdapter());
  const definitions = new InMemoryFormDefinitionRepository();
  definitions.versions.push(publishedVersion('f-1', 1));
  const repo = new InMemoryFormSubmissionRepository();
  const idempotency = new InMemoryFormIdempotencyStore();
  const audit = new StubFormAudit();
  return {
    fill,
    controller: new FormSubmissionController(
      uow,
      new DefaultSubmitFormUseCase(repo, definitions, fill, audit, idempotency),
      new DefaultReviseSubmissionUseCase(repo, definitions, fill, audit),
      new DefaultListSubmissionsQuery(repo),
    ),
  };
}

function submitBody(formId = 'f-1', versionNumber = 1) {
  return { formId, versionNumber, values: { name: '张三' } };
}

describe('FormSubmissionController（传输中立）', () => {
  it('提交 → 列表 → 修订 全链路', async () => {
    const { controller } = build();
    const submitted = await controller.submit(ACTOR, SCOPE, submitBody());
    if (!submitted.ok) {
      throw new Error('SUBMIT_FAIL:' + JSON.stringify(submitted));
    }
    assert.equal(submitted.ok, true, JSON.stringify((submitted as { value: unknown }).value));
    const id = (submitted as { value: { submissionId: string } }).value.submissionId;
    assert.equal(id.length > 0, true);

    const listed = await controller.list(ACTOR, SCOPE, 'f-1');
    if (!listed.ok) {
      throw new Error('LIST_FAIL:' + JSON.stringify(listed));
    }
    assert.equal(listed.ok, true, JSON.stringify((listed as { value: unknown }).value));
    const items = (listed as { value: readonly unknown[] }).value;
    assert.equal(items.length, 1);

    const revised = await controller.revise(ACTOR, id, { values: { name: '李四' } });
    if (!revised.ok) {
      throw new Error('REVISE_FAIL:' + JSON.stringify(revised));
    }
    assert.equal(revised.ok, true, JSON.stringify((revised as { value: unknown }).value));
    assert.equal((revised as { value: { revisionNumber: number } }).value.revisionNumber, 2);
  });

  it('权限失败关闭：FormFillPermission 拒绝 → 提交返回错误', async () => {
    const { controller, fill } = build();
    fill.allowed = false;
    const res = await controller.submit(ACTOR, SCOPE, submitBody());
    assert.equal(res.ok, false);
  });

  it('幂等：同 idempotencyKey 重复提交返回同一 id', async () => {
    const { controller } = build();
    const first = await controller.submit(ACTOR, SCOPE, {
      ...submitBody(),
      idempotencyKey: 'idem-1',
    });
    const second = await controller.submit(ACTOR, SCOPE, {
      ...submitBody(),
      idempotencyKey: 'idem-1',
    });
    assert.equal(first.ok, true, JSON.stringify((first as { value: unknown }).value));
    assert.equal(second.ok, true, JSON.stringify((second as { value: unknown }).value));
    assert.equal(
      (first as { value: { submissionId: string } }).value.submissionId,
      (second as { value: { submissionId: string } }).value.submissionId,
    );
  });
});
