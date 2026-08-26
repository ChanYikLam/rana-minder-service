/**
 * recruitment → invitation 跨模块端口（NestInvitationPort）回归测试（4.4b 收口）。
 *
 * 验证：
 * - 委托 CreateInvitationCommand 创建真实录取邀请（REC_OFFER），补足缺省有效期；
 * - 邀请创建失败时端口抛错（不得静默伪造成功）。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { NestInvitationPort } from './nest-invitation-port';
import type { CreateInvitationCommand } from '../../invitation/application/commands/create-invitation.command';
import type { CreateInvitationInput } from '../../invitation/application/commands/create-invitation.command';

describe('NestInvitationPort（recruitment → invitation 跨模块联动）', () => {
  it('委托 CreateInvitationCommand 创建录取邀请，缺省有效期由端口补足', async () => {
    const capturedBox: { value: CreateInvitationInput | null } = { value: null };
    const createInvitation: Pick<CreateInvitationCommand, 'execute'> = {
      execute: async (input: CreateInvitationInput) => {
        capturedBox.value = input;
        return {} as never;
      },
    };
    const port = new NestInvitationPort(createInvitation as CreateInvitationCommand);

    await port.createAdmissionInvitation({
      issuerId: 'manager-1',
      issuerClubId: 'club-1',
      inviteeId: 'applicant-1',
      clubId: 'club-1',
      decisionRef: 'path-1',
      expiresAt: '',
    });

    const captured = capturedBox.value;
    assert.ok(captured, '应调用 CreateInvitationCommand');
    assert.equal(captured.issuerId, 'manager-1');
    assert.equal(captured.issuerClubId, 'club-1');
    assert.equal(captured.inviteeId, 'applicant-1');
    assert.equal(captured.clubId, 'club-1');
    assert.equal(captured.decisionRef, 'path-1');
    assert.deepEqual(captured.issuerRoles, ['CLUB_LEADER', 'HR_ADMIN']);
    // 缺省有效期应为未来（约 7 天后）
    assert.ok(Date.parse(captured.expiresAt) > Date.now());
  });

  it('邀请创建失败时端口抛错（不静默伪造成功）', async () => {
    const createInvitation: Pick<CreateInvitationCommand, 'execute'> = {
      execute: async () => {
        throw new Error('IFC-ERR-006: 需要已复核的部门录取决定');
      },
    };
    const port = new NestInvitationPort(createInvitation as CreateInvitationCommand);
    await assert.rejects(
      () =>
        port.createAdmissionInvitation({
          issuerId: 'm',
          issuerClubId: 'c',
          inviteeId: 'a',
          clubId: 'c',
          decisionRef: '',
          expiresAt: '',
        }),
      /IFC-ERR-006/,
    );
  });
});
