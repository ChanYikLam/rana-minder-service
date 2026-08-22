import { Inject, Injectable } from '@nestjs/common';
import { INVITATION_REPOSITORY } from '../../infrastructure/invitation-repository';
import type { InvitationRepository } from '../../infrastructure/invitation-repository';

/** 邀请状态查询视图（IFC-SM-019 真实状态） */
export interface InvitationStatusView {
  readonly invitationId: string;
  readonly status: string;
  /** 是否已接受（不可逆事实） */
  readonly accepted: boolean;
  /** 成员身份生效状态（PROCESSING=生效处理中，未开放权限；ACTIVATED=已生效） */
  readonly activationStatus: string | null;
  /** 成员业务生效时间（= 接受时间） */
  readonly memberEffectiveAt: string | null;
  readonly expiresAt: string;
  readonly version: number;
}

/** 邀请状态查询失败（IFC-ERR-006） */
export class InvitationStatusQueryError extends Error {
  constructor(message: string) {
    super(`IFC-ERR-006: ${message}`);
    this.name = 'InvitationStatusQueryError';
  }
}

/**
 * 邀请状态查询（IFC-SM-019）。
 *
 * 返回真实状态；接受后若 Casdoor 回读未确认，页面显示
 * "成员身份生效处理中"，不得开放成员权限（REC-026、ORG-027）。
 */
@Injectable()
export class InvitationStatusQuery {
  constructor(@Inject(INVITATION_REPOSITORY) private readonly repo: InvitationRepository) {}

  async getStatus(invitationId: string): Promise<InvitationStatusView> {
    const invitation = await this.repo.load(invitationId);
    if (invitation === null) {
      throw new InvitationStatusQueryError('邀请不存在');
    }
    return {
      invitationId: invitation.invitationId,
      status: invitation.status,
      accepted: invitation.status === 'ACCEPTED',
      activationStatus: invitation.activation?.status ?? null,
      memberEffectiveAt: invitation.acceptedAt,
      expiresAt: invitation.expiresAt,
      version: invitation.version,
    };
  }
}
