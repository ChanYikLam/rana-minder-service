/**
 * recruitment → invitation 跨模块适配器（infrastructure；4.4b 收口）。
 *
 * 把 recruitment 领域的"发送录取邀请"委托给邀请模块的 CreateInvitationCommand，
 * 真正创建 INV-001 邀请对象（REC-024/REC-045），打通录取→邀请→接受→成员激活链路。
 *
 * 前置：recruitment 领域已在 SendAdmissionInvitationUseCase 内完成授权
 * （canManageRecruitment：负责人/人事），此处以 CLUB_LEADER/HR_ADMIN 角色
 * 交给邀请策略校验（REC-024 仅负责人/人事可发邀请）。
 */

import { Inject, Injectable } from '@nestjs/common';

import { CreateInvitationCommand } from '../../invitation/application/commands/create-invitation.command';
import type { InvitationPort, CreateAdmissionInvitationInput } from '../application/ports/invitation.port';

/** 邀请默认有效期（毫秒）：7 天 */
const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** 可发录取邀请的角色（负责人/人事，与邀请策略 ISSUER_ROLES 对齐） */
const ISSUER_ROLES: readonly string[] = ['CLUB_LEADER', 'HR_ADMIN'];

@Injectable()
export class NestInvitationPort implements InvitationPort {
  constructor(
    @Inject(CreateInvitationCommand)
    private readonly createInvitation: CreateInvitationCommand,
  ) {}

  async createAdmissionInvitation(input: CreateAdmissionInvitationInput): Promise<void> {
    const expiresAt = new Date(Date.now() + INVITATION_TTL_MS).toISOString();
    await this.createInvitation.execute({
      issuerId: input.issuerId,
      issuerRoles: [...ISSUER_ROLES],
      issuerClubId: input.issuerClubId,
      inviteeId: input.inviteeId,
      clubId: input.clubId,
      decisionRef: input.decisionRef,
      // 调用方未提供或提供空串时，用默认有效期（7 天）
      expiresAt: input.expiresAt || expiresAt,
    });
  }
}
