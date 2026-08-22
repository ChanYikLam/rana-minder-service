/**
 * OrgBacked 招新授权适配器单元测试（B2 授权地基）：
 * canManageRecruitment=club:recruitment:manage；canSubmitApplication=非现任成员。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type {
  CurrentPermissionsPort,
} from '../../organization/application/ports';
import { OrgBackedRecruitmentAuthorization } from './org-recruitment-authorization';

class FakePermissions implements CurrentPermissionsPort {
  constructor(
    private readonly effective: Map<string, string[]> = new Map(),
    private readonly roles: Map<string, string> = new Map(),
  ) {}
  async effectiveForClub(userId: string, clubId: string): Promise<string[]> {
    return this.effective.get(`${userId}@${clubId}`) ?? [];
  }
  async isPlatformSuperAdmin(userId: string): Promise<boolean> {
    return userId === 'u_root';
  }
  async primaryRoleAt(userId: string, clubId: string): Promise<string> {
    return this.roles.get(`${userId}@${clubId}`) ?? '';
  }
}

describe('OrgBackedRecruitmentAuthorization（REC 授权映射）', () => {
  const permissions = new FakePermissions(
    new Map([['u_leader@club-acm', ['club:recruitment:manage']]]),
    new Map([['u_member@club-acm', 'club-acm/成员组']]),
  );
  const port = new OrgBackedRecruitmentAuthorization(permissions);

  it('持 club:recruitment:manage 者可管理本社团招新', async () => {
    assert.equal(
      await port.canManageRecruitment({ clubId: 'club-acm', subjectId: 'u_leader' }),
      true,
    );
  });

  it('无该权限者（含超管——超管不混入社团权限，ORG-023）拒绝管理', async () => {
    assert.equal(
      await port.canManageRecruitment({ clubId: 'club-acm', subjectId: 'u_out' }),
      false,
    );
    assert.equal(
      await port.canManageRecruitment({ clubId: 'club-acm', subjectId: 'u_root' }),
      false,
    );
  });

  it('非现任成员可提交申请；现任成员拒绝', async () => {
    assert.equal(
      await port.canSubmitApplication({ clubId: 'club-acm', subjectId: 'u_new' }),
      true,
    );
    assert.equal(
      await port.canSubmitApplication({ clubId: 'club-acm', subjectId: 'u_member' }),
      false,
    );
  });
});
