/**
 * 归档访问策略（AUD-004 角色访问边界；纯规则）。
 *
 * 申请人：看自己报名/附件/公开结果/邀请，**不看内部评价/纠错/审计**；
 * 普通面试官：结束后**失去全部档案访问**；
 * 现任部门负责人：只看本部门路径；
 * 现任社团负责人/人事：看本社团全部历史；
 * 历史负责人/部长/离任成员：**不保留访问权**（按当前角色重新鉴权）；
 * 联合归档：按首次公布锁定参与关系与社团启用状态，被紧急停用参与社团
 * 停用期间不能查看；超管可查看全部归档但每次特权访问都审计。
 */

/** 归档内容类别（申请人只看自己范围；内部评价/纠错/审计拒绝） */
export const ArchiveContentKind = {
  /** 本人报名/附件/公开结果/邀请 */
  SELF: 'SELF',
  /** 内部评价/纠错/审计（仅有权角色） */
  INTERNAL: 'INTERNAL',
  /** 本部门路径 */
  DEPARTMENT_PATH: 'DEPARTMENT_PATH',
  /** 本社团全部历史 */
  CLUB_HISTORY: 'CLUB_HISTORY',
} as const;

export type ArchiveContentKind = (typeof ArchiveContentKind)[keyof typeof ArchiveContentKind];

/** 访问请求上下文（当前角色，非历史角色） */
export interface ArchiveAccessContext {
  readonly principalId: string;
  /** 当前有效角色 */
  readonly roles: readonly string[];
  /** 当前社团 */
  readonly clubId?: string;
  /** 当前部门（部门负责人） */
  readonly departmentId?: string;
  /** 是否申请人（本人） */
  readonly isApplicant?: boolean;
}

/** 归档访问结果 */
export interface ArchiveAccessDecision {
  readonly allowed: boolean;
  readonly errorCode?: 'IFC-ERR-003';
  /** 超管特权访问 → 必须审计（调用方写入 AuditWriter） */
  readonly privileged: boolean;
}

/** 访问拒绝异常 */
export class ArchiveAccessDeniedError extends Error {
  constructor(message: string) {
    super(`IFC-ERR-003: ${message}`);
    this.name = 'ArchiveAccessDeniedError';
  }
}

/** 归档访问策略（纯规则；AUD-004） */
export class ArchiveAccessPolicy {
  /**
   * 实时鉴权归档访问（按当前有效角色，不按历史职位）。
   *
   * @param context 当前角色上下文
   * @param archive 归档记录（参与关系/启用状态锁定快照）
   * @param requesterClubId 请求者请求的社团范围（null=全平台）
   */
  check(
    context: ArchiveAccessContext,
    archive: {
      participants: readonly { clubId: string; enabledAtLock: boolean }[];
      kind: string;
    },
    requesterClubId: string | null,
  ): ArchiveAccessDecision {
    // 超管：全部归档；特权访问必须审计
    if (context.roles.includes('SUPER_ADMIN')) {
      return { allowed: true, privileged: true };
    }
    // 面试官（且无负责人/人事/部门负责人资格）：结束后失去全部档案访问
    const isDepartmentLeader = context.roles.includes('DEPARTMENT_LEADER');
    if (
      context.roles.includes('INTERVIEWER') &&
      !this.isClubHandler(context.roles) &&
      !isDepartmentLeader
    ) {
      throw new ArchiveAccessDeniedError('面试官结束后失去全部档案访问');
    }
    // 申请人：仅自己范围（不看内部评价/纠错/审计）——由调用方限定内容类别
    if (context.isApplicant && !this.isClubHandler(context.roles) && !isDepartmentLeader) {
      if (requesterClubId !== null) {
        throw new ArchiveAccessDeniedError('申请人只能访问本人报名/附件/公开结果');
      }
      return { allowed: true, privileged: false };
    }
    // 历史负责人/部长/离任成员：不保留访问权（无现任社团负责人/人事/部门负责人角色 → 拒绝）
    if (!this.isClubHandler(context.roles) && !isDepartmentLeader) {
      throw new ArchiveAccessDeniedError('当前无归档访问角色');
    }
    // 现任部门负责人：仅本部门路径（需提供 departmentId 且限定范围）
    if (isDepartmentLeader && !this.isClubHandler(context.roles)) {
      if (context.departmentId === undefined || requesterClubId === null) {
        throw new ArchiveAccessDeniedError('部门负责人只能访问本部门路径');
      }
      return { allowed: true, privileged: false };
    }
    // 现任社团负责人/人事：本社团全部历史；需在参与社团内且社团锁定快照启用
    if (this.isClubHandler(context.roles)) {
      if (requesterClubId === null || context.clubId === undefined) {
        throw new ArchiveAccessDeniedError('负责人/人事只能访问本社团历史');
      }
      const participant = archive.participants.find((p) => p.clubId === context.clubId);
      if (participant === undefined) {
        throw new ArchiveAccessDeniedError('本社团不在该归档参与范围');
      }
      // 联合归档：被紧急停用参与社团停用期间不能查看
      if (!participant.enabledAtLock) {
        throw new ArchiveAccessDeniedError('参与社团停用期间不能查看归档');
      }
      return { allowed: true, privileged: false };
    }
    throw new ArchiveAccessDeniedError('当前无归档访问权限');
  }

  /** 内容类别边界（申请人不看内部评价/纠错/审计；AUD-004） */
  assertContentAllowed(
    context: ArchiveAccessContext,
    contentKind: ArchiveContentKind,
  ): void {
    if (contentKind === ArchiveContentKind.INTERNAL) {
      if (this.isClubHandler(context.roles) || context.roles.includes('SUPER_ADMIN')) {
        return;
      }
      throw new ArchiveAccessDeniedError('内部评价/纠错/审计仅有权角色可看');
    }
    // SELF = 本人记录（报名/附件/公开结果/邀请）：本人访问自己的记录一律允许，
    // 记录归属由调用方限定（objectId=principalId）；无额外角色限制
    if (contentKind === ArchiveContentKind.DEPARTMENT_PATH) {
      if (!context.roles.includes('DEPARTMENT_LEADER') && !this.isClubHandler(context.roles)) {
        throw new ArchiveAccessDeniedError('仅部门负责人/负责人可看部门路径');
      }
    }
  }

  private isClubHandler(roles: readonly string[]): boolean {
    return roles.some((r) => r === 'CLUB_LEADER' || r === 'HR_ADMIN');
  }
}
