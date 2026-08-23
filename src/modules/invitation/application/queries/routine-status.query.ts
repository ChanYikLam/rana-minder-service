import { Inject, Injectable, Optional } from '@nestjs/common';
import { InvitationPolicy } from '../../domain/services/invitation-policy';
import { ROUTINE_INVITATION_REPOSITORY } from '../../infrastructure/routine-invitation-repository';
import type { RoutineInvitationRepository } from '../../infrastructure/routine-invitation-repository';
import {
  CURRENT_PERMISSIONS_PORT,
  type CurrentPermissionsPort,
} from '../../../organization/application/ports';
import { PermissionCatalog } from '../../../organization/domain/models/permission-template';

/** 常规邀请状态查询视图（真实状态；IFC-SM-023） */
export interface RoutineInvitationStatusView {
  readonly routineInvitationId: string;
  readonly status: string;
  /** 已接受待生效/同步处理中 → 页面显示"成员身份生效处理中"，不得开放成员权限 */
  readonly activationPending: boolean;
  /** 是否已生效（全部回读确认） */
  readonly activated: boolean;
  /** 组合关系同步状态 */
  readonly syncStatus: string | null;
  readonly initialDepartmentId: string | null;
  readonly expiresAt: string;
  readonly version: number;
}

/** 常规入社邀请状态查询失败（IFC-ERR-006 / IFC-ERR-003 当前无权） */
export class RoutineInvitationStatusQueryError extends Error {
  constructor(code: 'IFC-ERR-006' | 'IFC-ERR-003', message: string) {
    super(`${code}: ${message}`);
    this.name = 'RoutineInvitationStatusQueryError';
  }
}

/** 查看者上下文（调用方注入当前登录者，用于访问控制） */
export interface RoutineInvitationViewerContext {
  readonly principalId: string;
  readonly roles: readonly string[];
  /** 查看者所属社团（用于校验是否为邀请所属社团的负责人/人事） */
  readonly clubId: string;
}

/**
 * 常规入社邀请状态查询（IFC-SM-023）。
 *
 * 已接受待生效/同步失败待重试/高优先级同步异常期间不开放成员权限；
 * 高优先级同步异常由超级管理员处置（本查询暴露异常标志）。
 *
 * 访问控制（IFC-ERR-003）：传入 {@link RoutineInvitationViewerContext} 时，仅
 * - 邀请指定本人；或
 * - 发出社团的负责人/人事管理员
 * 可查看真实状态，避免按 invitationId 枚举他人邀请造成信息泄露。
 */
@Injectable()
export class RoutineInvitationStatusQuery {
  constructor(
    @Inject(ROUTINE_INVITATION_REPOSITORY) private readonly repo: RoutineInvitationRepository,
    private readonly policy: InvitationPolicy = new InvitationPolicy(),
    @Optional()
    @Inject(CURRENT_PERMISSIONS_PORT)
    private readonly permissions?: CurrentPermissionsPort,
  ) {}

  async getStatus(
    routineInvitationId: string,
    viewer?: RoutineInvitationViewerContext,
  ): Promise<RoutineInvitationStatusView> {
    const invitation = await this.repo.load(routineInvitationId);
    if (invitation === null) {
      throw new RoutineInvitationStatusQueryError('IFC-ERR-006', '邀请不存在');
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
            throw new RoutineInvitationStatusQueryError('IFC-ERR-003', '当前无权查看');
          }
        } else {
          // 回退（无权限端口装配，如领域单测）：按 caller 提供的角色/社团校验
          this.policy.assertCanIssueForClub(viewer.roles, viewer.clubId, invitation.clubId);
        }
      }
    }
    return {
      routineInvitationId: invitation.routineInvitationId,
      status: invitation.status,
      activationPending:
        invitation.status === 'ACCEPTED_PENDING_ACTIVATION' ||
        invitation.status === 'SYNC_FAILED_PENDING_RETRY' ||
        invitation.status === 'HIGH_PRIORITY_SYNC_ANOMALY',
      activated: invitation.status === 'ACTIVATED',
      syncStatus: invitation.syncStatus,
      initialDepartmentId: invitation.initialDepartmentId,
      expiresAt: invitation.expiresAt,
      version: invitation.version,
    };
  }
}
