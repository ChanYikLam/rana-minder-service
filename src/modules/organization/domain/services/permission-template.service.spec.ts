import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { PermissionCatalog } from '../models/permission-template';
import { PermissionTemplateService } from './permission-template.service';

describe('PermissionTemplateService', () => {
  it('内置模板：三套（负责人/人事/部门负责人）均可发布', () => {
    const templates = PermissionTemplateService.builtInTemplates();
    assert.deepEqual(
      templates.map((t) => t.id),
      ['ptpl-builtin-leader', 'ptpl-builtin-personnel', 'ptpl-builtin-dept-head'],
    );
    for (const t of templates) {
      assert.equal(t.draft, null);
      assert.equal(t.published?.version, 1);
    }
    assert.equal(templates[0].scopeClass, 'club');
    assert.equal(templates[2].scopeClass, 'department');
  });

  it('diff：新增/移除权限差异', () => {
    const d = PermissionTemplateService.diff(
      ['club:member:manage'],
      ['club:member:manage', 'club:interview:view'],
    );
    assert.deepEqual(d.added, ['club:interview:view']);
    assert.deepEqual(d.removed, []);
  });

  it('validateDraftPermissions：未知权限拒绝；平台超管权限社团级模板拒绝（GOV-007）', () => {
    assert.throws(
      () => PermissionTemplateService.validateDraftPermissions('club', ['not-a-permission']),
      (e: Error) => e.message.includes('权限项目录'),
    );
    assert.throws(
      () =>
        PermissionTemplateService.validateDraftPermissions('club', [
          PermissionCatalog.PLATFORM_CONFIG_MANAGE,
        ]),
      (e: Error) => e.message.includes('超出社团级别范围') || e.message.includes('平台超管'),
    );
  });

  it('部门级模板不得突破部门范围（ORG-035）', () => {
    assert.throws(
      () =>
        PermissionTemplateService.validateDraftPermissions('department', [
          PermissionCatalog.CLUB_TRANSITION_MANAGE,
        ]),
      (e: Error) => e.message.includes('超出部门级别范围'),
    );
    // 部门内可配置的权限通过
    const ok = PermissionTemplateService.validateDraftPermissions('department', [
      PermissionCatalog.CLUB_MEMBER_MANAGE,
    ]);
    assert.deepEqual(ok, ['club:member:manage']);
  });

  it('createTemplateDraft：新模板生成草稿并递增版本', () => {
    const draft = PermissionTemplateService.createTemplateDraft(
      null,
      '招新组',
      ['club:recruitment:manage'],
      '2026-08-01T00:00:00.000Z',
    );
    assert.equal(draft.builtIn, false);
    assert.equal(draft.draft?.version, 1);
    assert.deepEqual(draft.draft?.permissions, ['club:recruitment:manage']);
    assert.equal(draft.published, null);
  });
});
