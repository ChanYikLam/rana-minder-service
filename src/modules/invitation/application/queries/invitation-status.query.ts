import { Inject, Injectable } from '@nestjs/common';
import { InvitationPolicy } from '../../domain/services/invitation-policy';
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

/** 邀请状态查询失败（IFC-ERR-006 / IFC-ERR-003 当前无权） */
export class InvitationStatusQueryError extends Error {
  constructor(code: 'IFC-ERR-006' | 'IFC-ERR-003', message: string) {
    super(`${code}: ${message}`);
    this.name = 'InvitationStatusQueryError';
  }
}

/** 查看者上下文（调用方注入当前登录者，用于访问控制） */
export interface InvitationViewerContext {
  readonly principalId: string;
  readonly roles: readonly string[];
}

/**
 * 邀请状态查询（IFC-SM-019）。
 *
 * 返回真实状态；接受后若 Casdoor 回读未确认，页面显示
 * "成员身份生效处理中"，不得开放成员权限（REC-026、ORG-027）。
 *
 * 访问控制（IFC-ERR-003）：传入 {@link InvitationViewerContext} 时，仅
 * - 邀请指定本人；或
 * - 发出社团的负责人/人事管理员
 * 可查看真实状态，避免按 invitationId 枚举他人邀请造成信息泄露。
 */
@Injectable()
export class InvitationStatusQuery {
  constructor(
    @Inject(INVITATION_REPOSITORY) private readonly repo: InvitationRepository,
    private readonly policy: InvitationPolicy = new InvitationPolicy(),
  ) {}

  async getStatus(
    invitationId: string,
    viewer?: InvitationViewerContext,
  ): Promise<InvitationStatusView> {
    const invitation = await this.repo.load(invitationId);
    if (invitation === null) {
      throw new InvitationStatusQueryError('IFC-ERR-006', '邀请不存在');
    }
    if (viewer !== undefined) {
      // 本人 或 发出社团负责人/人事 可查看；其余无权（IFC-ERR-003）
      const isInvitee = viewer.principalId === invitation.inviteeId;
      if (!isInvitee) {
        this.policy.assertCanIssue(viewer.roles);
      }
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
