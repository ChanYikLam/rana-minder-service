import { Inject, Injectable, Optional } from '@nestjs/common';
import { InvitationPolicy } from '../../domain/services/invitation-policy';
import { INVITATION_REPOSITORY } from '../../infrastructure/invitation-repository';
import type { InvitationRepository } from '../../infrastructure/invitation-repository';
import {
  CURRENT_PERMISSIONS_PORT,
  type CurrentPermissionsPort,
} from '../../../organization/application/ports';
import { PermissionCatalog } from '../../../organization/domain/models/permission-template';

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
  readonly code: 'IFC-ERR-006' | 'IFC-ERR-003';
  constructor(code: 'IFC-ERR-006' | 'IFC-ERR-003', message: string) {
    super(`${code}: ${message}`);
    this.name = 'InvitationStatusQueryError';
    this.code = code;
  }
}

/** 查看者上下文（调用方注入当前登录者，用于访问控制） */
export interface InvitationViewerContext {
  readonly principalId: string;
  readonly roles: readonly string[];
  /** 查看者所属社团（用于校验是否为邀请所属社团的负责人/人事） */
  readonly clubId: string;
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
    @Optional()
    @Inject(CURRENT_PERMISSIONS_PORT)
    private readonly permissions?: CurrentPermissionsPort,
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
        // 权限化授权（GOV-007）：以邀请所属社团的 club:invite:manage 权限判定，
        // 使 HTTP 层无需预知 caller 角色/社团即可正确放行“发文社团可查看”。
        if (this.permissions !== undefined) {
          const effective = await this.permissions.effectiveForClub(
            viewer.principalId,
            invitation.clubId,
          );
          if (!effective.includes(PermissionCatalog.CLUB_INVITE_MANAGE)) {
            throw new InvitationStatusQueryError('IFC-ERR-003', '当前无权查看');
          }
        } else {
          // 回退（无权限端口装配，如领域单测）：按 caller 提供的角色/社团校验
          this.policy.assertCanIssueForClub(viewer.roles, viewer.clubId, invitation.clubId);
        }
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
