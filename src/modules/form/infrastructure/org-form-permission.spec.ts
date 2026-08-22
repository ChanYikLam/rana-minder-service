/**
 * OrgBacked 授权适配器单元测试（B2 授权地基）：
 *
 * 用受控的假 CurrentPermissionsPort 固定语义映射与 fail-closed 边界：
 * - recruitment：manage=club:recruitment:manage；submit=非现任成员
 * - form design：platform=仅超管；club=管理类权限任一；department=fail-closed
 * - notification kill-switch：PLATFORM=仅超管；CLUB=超管或 club:member:manage
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type {
  CurrentPermissionsPort,
} from '../../organization/application/ports';
import { PLATFORM_SCOPE } from '../domain/models/form-scope';
import { formScopeOf } from '../domain/models/form-scope';
import { OrgBackedFormDesignPermission } from './org-form-design-permission';
import { OrgBackedFormFillPermission } from './org-form-fill-permission';

class FakePermissions implements CurrentPermissionsPort {
  constructor(
    private readonly effective: Map<string, string[]> = new Map(),
    private readonly superAdmins: ReadonlySet<string> = new Set(),
    private readonly roles: Map<string, string> = new Map(),
  ) {}

  async effectiveForClub(userId: string, clubId: string): Promise<string[]> {
    return this.effective.get(`${userId}@${clubId}`) ?? [];
  }
  async isPlatformSuperAdmin(userId: string): Promise<boolean> {
    return this.superAdmins.has(userId);
  }
  async primaryRoleAt(userId: string, clubId: string): Promise<string> {
    return this.roles.get(`${userId}@${clubId}`) ?? '';
  }
}

describe('OrgBackedFormDesignPermission（FORM-002 映射）', () => {
  const superadmin = new FakePermissions(
    new Map(),
    new Set(['u_root']),
  );
  const leader = new FakePermissions(
    new Map([['u_leader@club-acm', ['club:recruitment:manage']]]),
  );
  const plain = new FakePermissions();

  it('platform 作用域：超管可设计，普通主体拒绝', async () => {
    const port = new OrgBackedFormDesignPermission(superadmin);
    assert.equal(await port.canDesign({ subjectId: 'u_root' }, PLATFORM_SCOPE), true);
    assert.equal(
      await new OrgBackedFormDesignPermission(plain).canDesign(
        { subjectId: 'u_x' },
        PLATFORM_SCOPE,
      ),
      false,
    );
  });

  it('club 作用域：持任一管理类权限可设计，无权限拒绝', async () => {
    const port = new OrgBackedFormDesignPermission(leader);
    assert.equal(
      await port.canDesign({ subjectId: 'u_leader' }, formScopeOf('club', 'club-acm')),
      true,
    );
    assert.equal(
      await port.canDesign({ subjectId: 'u_nobody' }, formScopeOf('club', 'club-acm')),
      false,
    );
  });

  it('department 作用域：fail-closed（ORG-035 契约未落地前不放行）', async () => {
    const port = new OrgBackedFormDesignPermission(leader);
    assert.equal(
      await port.canDesign(
        { subjectId: 'u_leader' },
        formScopeOf('department', 'club-acm'),
      ),
      false,
    );
  });

  it('canManagePlatform 仅超管', async () => {
    assert.equal(
      await new OrgBackedFormDesignPermission(superadmin).canManagePlatform({
        subjectId: 'u_root',
      }),
      true,
    );
    assert.equal(
      await new OrgBackedFormDesignPermission(leader).canManagePlatform({
        subjectId: 'u_leader',
      }),
      false,
    );
  });
});

describe('OrgBackedFormFillPermission（FORM-002 成员资格映射）', () => {
  const member = new FakePermissions(
    new Map(),
    new Set(),
    new Map([['u_m@club-acm', 'club-acm/负责人组']]),
  );

  it('platform 作用域：已认证主体即可填写', async () => {
    const result = await new OrgBackedFormFillPermission(member).canFill({
      formId: 'f1',
      versionNumber: 1,
      scope: PLATFORM_SCOPE,
      subjectId: 'u_any',
    });
    assert.deepEqual(result, { allowed: true });
  });

  it('club 作用域：成员可填写，非成员拒绝并给出原因', async () => {
    const port = new OrgBackedFormFillPermission(member);
    assert.deepEqual(
      await port.canFill({
        formId: 'f1',
        versionNumber: 1,
        scope: formScopeOf('club', 'club-acm'),
        subjectId: 'u_m',
      }),
      { allowed: true },
    );
    assert.deepEqual(
      await port.canFill({
        formId: 'f1',
        versionNumber: 1,
        scope: formScopeOf('club', 'club-acm'),
        subjectId: 'u_out',
      }),
      { allowed: false, reason: 'FORM-FILL-NOT-CLUB-MEMBER' },
    );
  });
});
