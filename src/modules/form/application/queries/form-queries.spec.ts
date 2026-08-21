/**
 * form 查询用例测试（列表/定义/设计器编辑态/平台模板/模板申请）。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DefaultListFormsQuery } from './list-forms.query';
import { DefaultGetFormDefinitionQuery } from './get-form-definition.query';
import { DefaultGetFormDesignerStateQuery } from './get-form-designer-state.query';
import { DefaultListPlatformTemplatesQuery } from './list-platform-templates.query';
import { DefaultListTemplatePublicationsQuery } from './list-template-publications.query';
import {
  InMemoryFormDefinitionRepository,
  StubFormDesignPermission,
} from '../testing/form-test-support';
import { FormVersion } from '../../domain/models/form-version';
import { FormDefinition } from '../../domain/models/form-definition';
import { FormVersionState } from '../../domain/state-machines/form-version.state-machine';
import type { FormScope } from '../../domain/models/form-scope';
import { FormCommandError, FormErrorCode } from '../errors';

const CLUB: FormScope = { kind: 'club', ownerId: 'club-1' };
const NOW = new Date('2026-08-20T08:00:00.000Z');

function seedRoot(repository: InMemoryFormDefinitionRepository, id: string, scope: FormScope) {
  const root = FormDefinition.create({
    id,
    scope,
    kind: 'FORM',
    title: `表单-${id}`,
    description: null,
    businessFamily: null,
    createdBy: 'leader-1',
    now: NOW,
  });
  root.pointDraft(1, NOW);
  repository.roots.push(root.toSnapshot());
  return root;
}

describe('form 查询', () => {
  it('列表：按作用域过滤，最新草稿状态推导为 draft', async () => {
    const repository = new InMemoryFormDefinitionRepository();
    seedRoot(repository, 'f-1', CLUB);
    seedRoot(repository, 'f-2', { kind: 'club', ownerId: 'club-2' });
    repository.versions.push(
      FormVersion.createDraft({
        id: 'v-1',
        formId: 'f-1',
        versionNumber: 1,
        fields: [],
        sourceFormId: null,
        sourceVersion: null,
        createdBy: 'leader-1',
        now: NOW,
      }).toSnapshot(),
    );
    const query = new DefaultListFormsQuery(repository, new StubFormDesignPermission());
    const result = await query.execute({ scope: CLUB, actor: 'leader-1' });
    assert.equal(result.items.length, 1);
    assert.equal(result.items[0].formId, 'f-1');
    assert.equal(result.items[0].status, 'draft');
  });

  it('列表：无草稿有发布版本 → published', async () => {
    const repository = new InMemoryFormDefinitionRepository();
    const root = seedRoot(repository, 'f-1', CLUB);
    root.pointPublished(1, NOW);
    repository.roots[0] = root.toSnapshot();
    repository.versions.push(
      FormVersion.createPublished({
        id: 'v-1',
        formId: 'f-1',
        versionNumber: 1,
        fields: [],
        sourceFormId: null,
        sourceVersion: null,
        publishedBy: 'leader-1',
        now: NOW,
      }).toSnapshot(),
    );
    const query = new DefaultListFormsQuery(repository, new StubFormDesignPermission());
    const result = await query.execute({ scope: CLUB, actor: 'leader-1' });
    assert.equal(result.items[0].status, 'published');
  });

  it('定义查询：返回全部版本（升序）与状态映射；草稿优先于发布指针', async () => {
    const repository = new InMemoryFormDefinitionRepository();
    const root = seedRoot(repository, 'f-1', CLUB);
    root.pointPublished(1, NOW);
    repository.roots[0] = root.toSnapshot();
    repository.versions.push(
      FormVersion.createDraft({
        id: 'v-1',
        formId: 'f-1',
        versionNumber: 1,
        fields: [],
        sourceFormId: null,
        sourceVersion: null,
        createdBy: 'leader-1',
        now: NOW,
      }).toSnapshot(),
    );
    const query = new DefaultGetFormDefinitionQuery(repository, new StubFormDesignPermission());
    const result = await query.execute({ formId: 'f-1', actor: 'leader-1' });
    assert.equal(result.versions.length, 1);
    assert.equal(result.versions[0].status, 'draft');
    assert.equal(result.currentPublishedVersion, 1);
  });

  it('设计器编辑态：最新草稿优先，无草稿回退已发布', async () => {
    const repository = new InMemoryFormDefinitionRepository();
    const root = seedRoot(repository, 'f-1', CLUB);
    root.pointPublished(1, NOW);
    repository.roots[0] = root.toSnapshot();
    repository.versions.push(
      FormVersion.createDraft({
        id: 'v-1',
        formId: 'f-1',
        versionNumber: 1,
        fields: [],
        sourceFormId: null,
        sourceVersion: null,
        createdBy: 'leader-1',
        now: NOW,
      }).toSnapshot(),
    );
    const query = new DefaultGetFormDesignerStateQuery(repository, new StubFormDesignPermission());
    const result = await query.execute({ formId: 'f-1', actor: 'leader-1' });
    assert.equal(result.status, FormVersionState.DRAFT.toLowerCase());
    assert.equal(result.version, 1);
  });

  it('设计器编辑态：未知表单 404（IFC-ERR-015）', async () => {
    const repository = new InMemoryFormDefinitionRepository();
    const query = new DefaultGetFormDesignerStateQuery(repository, new StubFormDesignPermission());
    await assert.rejects(
      query.execute({ formId: 'missing', actor: 'leader-1' }),
      (error: FormCommandError) => error.code === FormErrorCode.NOT_FOUND,
    );
  });

  it('平台模板列表：只列有发布版本的 TEMPLATE', async () => {
    const repository = new InMemoryFormDefinitionRepository();
    const template = FormDefinition.create({
      id: 't-1',
      scope: { kind: 'platform', ownerId: null },
      kind: 'TEMPLATE',
      title: '模板',
      description: null,
      businessFamily: null,
      createdBy: 'super-1',
      now: NOW,
    });
    template.pointPublished(1, NOW);
    repository.roots.push(template.toSnapshot());
    const unpublished = FormDefinition.create({
      id: 't-2',
      scope: { kind: 'platform', ownerId: null },
      kind: 'TEMPLATE',
      title: '未发布模板',
      description: null,
      businessFamily: null,
      createdBy: 'super-1',
      now: NOW,
    });
    repository.roots.push(unpublished.toSnapshot());
    const query = new DefaultListPlatformTemplatesQuery(repository);
    const result = await query.execute();
    assert.equal(result.items.length, 1);
    assert.equal(result.items[0].templateId, 't-1');
  });

  it('模板申请列表：按状态筛选并附来源表单标题', async () => {
    const repository = new InMemoryFormDefinitionRepository();
    seedRoot(repository, 'f-1', CLUB);
    repository.publications.push({
      id: 'pub-1',
      formId: 'f-1',
      sourceVersion: 1,
      status: 'PENDING',
      note: null,
      requestedBy: 'leader-1',
      requestedAt: NOW,
      decidedBy: null,
      decidedAt: null,
      decisionReason: null,
      templateFormId: null,
      version: 0,
    });
    const query = new DefaultListTemplatePublicationsQuery(
      repository,
      new StubFormDesignPermission(),
    );
    const result = await query.execute({ status: 'PENDING', actor: 'super-1' });
    assert.equal(result.items.length, 1);
    assert.equal(result.items[0].formTitle, '表单-f-1');
  });

  it('查询权限失败关闭：无权查看模板申请 → 403', async () => {
    const repository = new InMemoryFormDefinitionRepository();
    const permission = new StubFormDesignPermission();
    permission.platformAllowed = false;
    const query = new DefaultListTemplatePublicationsQuery(repository, permission);
    await assert.rejects(
      query.execute({ status: 'PENDING', actor: 'member-1' }),
      (error: FormCommandError) => error.code === FormErrorCode.FORBIDDEN,
    );
  });

  it('查询权限失败关闭：无权查看列表 → 403', async () => {
    const repository = new InMemoryFormDefinitionRepository();
    const permission = new StubFormDesignPermission();
    permission.allowed = false;
    const query = new DefaultListFormsQuery(repository, permission);
    await assert.rejects(
      query.execute({ scope: CLUB, actor: 'member-1' }),
      (error: FormCommandError) => error.code === FormErrorCode.FORBIDDEN,
    );
  });
});
