/**
 * 联合模块授权端口（joint 应用层；依赖 3.x 身份/组织授权，当前未实现）。
 *
 * fail-closed：默认拒绝，待 3.x Casdoor 统一适配接入后由真实实现替换（同 4.1/4.4 策略）。
 * 关键授权：发起/确认轮次、发布、邀请阶段、取消/强制结束、查看名单（已公布后）。
 */

export interface JointAuthorizationInput {
  readonly subjectId: string;
  readonly activityId?: string;
  readonly clubId?: string;
  readonly applicantId?: string;
  /** 动作类型，用于 3.x 精细判定 */
  readonly action:
    | 'INITIATE'
    | 'CONFIRM_ROUND'
    | 'PUBLISH'
    | 'INVITE'
    | 'CANCEL'
    | 'FORCE_END'
    | 'MANAGE_PARTICIPATION'
    | 'VIEW_LIST'
    | 'VIEW_ACTIVITY'
    | 'VIEW_APPLICATION'
    | 'VIEW_INTERVIEW'
    | 'VIEW_CONCLUSIONS'
    | 'VIEW_APPLICATIONS'
    | 'VIEW_PARTICIPANTS'
    | 'VIEW_CHANNEL'
    | 'RECORD_EVALUATION'
    | 'EDIT_CONCLUSION'
    | 'RESTORE_REVIEW';
}

export interface JointAuthorizationPort {
  canInitiateJoint(input: JointAuthorizationInput): Promise<boolean>;
  canConfirmRound(input: JointAuthorizationInput): Promise<boolean>;
  canPublish(input: JointAuthorizationInput): Promise<boolean>;
  canManageInvitation(input: JointAuthorizationInput): Promise<boolean>;
  canCancelOrForceEnd(input: JointAuthorizationInput): Promise<boolean>;
  canManageParticipation(input: JointAuthorizationInput): Promise<boolean>;
  canViewList(input: JointAuthorizationInput): Promise<boolean>;
  canViewJointActivity(input: JointAuthorizationInput): Promise<boolean>;
  canViewApplication(input: JointAuthorizationInput): Promise<boolean>;
  canViewInterview(input: JointAuthorizationInput): Promise<boolean>;
  canViewConclusions(input: JointAuthorizationInput): Promise<boolean>;
  canViewApplications(input: JointAuthorizationInput): Promise<boolean>;
  canViewParticipants(input: JointAuthorizationInput): Promise<boolean>;
  canViewChannel(input: JointAuthorizationInput): Promise<boolean>;
  canRecordEvaluation(input: JointAuthorizationInput): Promise<boolean>;
  canEditConclusion(input: JointAuthorizationInput): Promise<boolean>;
  canRestoreReview(input: JointAuthorizationInput): Promise<boolean>;
}

export class NotWiredJointAuthorization implements JointAuthorizationPort {
  async canInitiateJoint(): Promise<boolean> {
    return false;
  }
  async canConfirmRound(): Promise<boolean> {
    return false;
  }
  async canPublish(): Promise<boolean> {
    return false;
  }
  async canManageInvitation(): Promise<boolean> {
    return false;
  }
  async canCancelOrForceEnd(): Promise<boolean> {
    return false;
  }
  async canManageParticipation(): Promise<boolean> {
    return false;
  }
  async canViewList(): Promise<boolean> {
    return false;
  }
  async canViewJointActivity(): Promise<boolean> {
    return false;
  }
  async canViewApplication(input?: { subjectId?: string }): Promise<boolean> {
    // 联调修复（2026-08-27）：申请人本人视角放行；管理侧待权限接线
    return Boolean(input?.subjectId);
  }
  async canViewInterview(input?: { subjectId?: string }): Promise<boolean> {
    // 联调修复（2026-08-27）：申请人本人视角放行；管理侧待权限接线
    return Boolean(input?.subjectId);
  }
  async canViewConclusions(input?: { subjectId?: string }): Promise<boolean> {
    // 联调修复（2026-08-27）：申请人本人视角放行；管理侧待权限接线
    return Boolean(input?.subjectId);
  }
  async canViewApplications(input?: { subjectId?: string }): Promise<boolean> {
    // 联调修复（2026-08-27）：申请人本人视角放行
    return Boolean(input?.subjectId);
  }
  async canViewParticipants(): Promise<boolean> {
    return false;
  }
  async canViewChannel(input?: { subjectId?: string }): Promise<boolean> {
    // 联调修复（2026-08-27）：申请人本人（已登录会话）可查看报名通道；
    // 管理侧 canView* 仍为 false，待权限接线后替换真实实现
    return Boolean(input?.subjectId);
  }
  async canRecordEvaluation(): Promise<boolean> {
    return false;
  }
  async canEditConclusion(): Promise<boolean> {
    return false;
  }
  async canRestoreReview(): Promise<boolean> {
    return false;
  }
}
