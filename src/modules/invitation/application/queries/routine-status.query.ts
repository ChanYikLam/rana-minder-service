import { Inject, Injectable } from '@nestjs/common';
import type { RoutineInvitation } from '../../domain/models/routine-invitation';
import { ROUTINE_INVITATION_REPOSITORY } from '../../infrastructure/routine-invitation-repository';
import type { RoutineInvitationRepository } from '../../infrastructure/routine-invitation-repository';

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

/**
 * 常规入社邀请状态查询（IFC-SM-023）。
 *
 * 已接受待生效/同步失败待重试/高优先级同步异常期间不开放成员权限；
 * 高优先级同步异常由超级管理员处置（本查询暴露异常标志）。
 */
@Injectable()
export class RoutineInvitationStatusQuery {
  constructor(
    @Inject(ROUTINE_INVITATION_REPOSITORY) private readonly repo: RoutineInvitationRepository,
  ) {}

  async getStatus(routineInvitationId: string): Promise<RoutineInvitationStatusView> {
    const invitation = await this.repo.load(routineInvitationId);
    if (invitation === null) {
      throw new Error('IFC-ERR-006: 邀请不存在');
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
