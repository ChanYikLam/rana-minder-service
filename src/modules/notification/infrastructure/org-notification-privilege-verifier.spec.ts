/**
 * OrgBacked 站内信紧急关闭特权校验单元测试（B2 授权地基）：
 * PLATFORM 仅超管；CLUB 超管或 club:member:manage。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type {
  CurrentPermissionsPort,
} from '../../organization/application/ports';
import { OrgBackedNotificationPrivilegeVerifier } from './org-notification-privilege-verifier';

class FakePermissions implements CurrentPermissionsPort {
  constructor(
    private readonly effective: Map<string, string[]> = new Map(),
    private readonly superAdmins: ReadonlySet<string> = new Set(),
  ) {}
  async effectiveForClub(userId: string, clubId: string): Promise<string[]> {
    return this.effective.get(`${userId}@${clubId}`) ?? [];
  }
  async isPlatformSuperAdmin(userId: string): Promise<boolean> {
    return this.superAdmins.has(userId);
  }
  async primaryRoleAt(): Promise<string> {
    return '';
  }
}

describe('OrgBackedNotificationPrivilegeVerifier（kill-switch 特权映射）', () => {
  const permissions = new FakePermissions(
    new Map([['u_hr@club-acm', ['club:member:manage']]]),
    new Set(['u_root']),
  );
  const verifier = new OrgBackedNotificationPrivilegeVerifier(permissions);

  it('PLATFORM 范围：仅超管可操作', async () => {
    assert.equal(await verifier.canOperateKillSwitch('PLATFORM', null, 'u_root'), true);
    assert.equal(await verifier.canOperateKillSwitch('PLATFORM', null, 'u_hr'), false);
  });

  it('CLUB 范围：超管或该社团管理员可操作', async () => {
    assert.equal(
      await verifier.canOperateKillSwitch('CLUB', 'club-acm', 'u_root'),
      true,
    );
    assert.equal(
      await verifier.canOperateKillSwitch('CLUB', 'club-acm', 'u_hr'),
      true,
    );
  });

  it('CLUB 范围：无权限者拒绝；CLUB 范围缺 clubId 拒绝（fail-closed）', async () => {
    assert.equal(
      await verifier.canOperateKillSwitch('CLUB', 'club-acm', 'u_out'),
      false,
    );
    assert.equal(
      await verifier.canOperateKillSwitch('CLUB', null, 'u_hr'),
      false,
    );
  });
});
