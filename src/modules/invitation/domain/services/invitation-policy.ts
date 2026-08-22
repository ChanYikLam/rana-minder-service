/**
 * 邀请权限规则（REC-024、MEM-018、SRS-SM-INV-001）。
 *
 * - 仅**社团负责人/人事管理员**可发/撤/重发普通录取邀请；
 * - **部门负责人/面试官/成员无权**（IFC-ERR-003 当前无权）；
 * - 接受/拒绝仅邀请指定本人（账号有效等由调用方复核）。
 */
export const CLUB_LEADER_ROLE = 'CLUB_LEADER';
export const HR_ADMIN_ROLE = 'HR_ADMIN';

/** 可发/撤/重发邀请的角色集合（REC-024） */
const ISSUER_ROLES: readonly string[] = [CLUB_LEADER_ROLE, HR_ADMIN_ROLE];

/** 无权异常（IFC-ERR-003 当前无权） */
export class InvitationForbiddenError extends Error {
  constructor(message: string) {
    super(`IFC-ERR-003: ${message}`);
    this.name = 'InvitationForbiddenError';
  }
}

/** 前置失败异常（IFC-ERR-006 业务前置条件失败） */
export class InvitationPreconditionError extends Error {
  constructor(message: string) {
    super(`IFC-ERR-006: ${message}`);
    this.name = 'InvitationPreconditionError';
  }
}

/**
 * 邀请权限策略（纯规则）。
 */
export class InvitationPolicy {
  /** 发出/撤回/重发：仅负责人/人事；部门负责人/面试官/成员无权（REC-024） */
  assertCanIssue(roles: readonly string[]): void {
    if (!roles.some((r) => ISSUER_ROLES.includes(r))) {
      throw new InvitationForbiddenError('仅社团负责人/人事管理员可操作邀请');
    }
  }

  /**
   * 发出/撤回/重发/查看：仅目标社团的负责人/人事（REC-024）。
   * 除角色校验外，还须校验操作者**属于目标社团**，防止跨社团越权
   * （A 社团负责人撤回/重发/查看 B 社团邀请，IFC-ERR-003）。
   */
  assertCanIssueForClub(roles: readonly string[], principalClubId: string, clubId: string): void {
    this.assertCanIssue(roles);
    if (principalClubId !== clubId) {
      throw new InvitationForbiddenError('仅邀请所属社团的负责人/人事可操作');
    }
  }

  /** 接受/拒绝：仅邀请指定本人 */
  assertIsInvitee(principalId: string, inviteeId: string): void {
    if (principalId !== inviteeId) {
      throw new InvitationForbiddenError('仅邀请指定本人可操作');
    }
  }
}
