/**
 * 联合模块授权端口（joint 应用层；依赖 3.x 身份/组织授权，当前未实现）。
 *
 * fail-closed：默认拒绝，待 3.x Casdoor 统一适配接入后由真实实现替换（同 4.1/4.4 策略）。
 * 关键授权：发起/确认轮次、发布、邀请阶段、取消/强制结束、查看名单（已公布后）。
 */

export interface JointAuthorizationInput {
  readonly activityId?: string;
  readonly subjectId: string;
  /** 动作类型，用于 3.x 精细判定 */
  readonly action:
    | 'INITIATE'
    | 'CONFIRM_ROUND'
    | 'PUBLISH'
    | 'INVITE'
    | 'CANCEL'
    | 'FORCE_END'
    | 'MANAGE_PARTICIPATION'
    | 'VIEW_LIST';
}

export interface JointAuthorizationPort {
  canInitiateJoint(input: JointAuthorizationInput): Promise<boolean>;
  canConfirmRound(input: JointAuthorizationInput): Promise<boolean>;
  canPublish(input: JointAuthorizationInput): Promise<boolean>;
  canManageInvitation(input: JointAuthorizationInput): Promise<boolean>;
  canCancelOrForceEnd(input: JointAuthorizationInput): Promise<boolean>;
  canManageParticipation(input: JointAuthorizationInput): Promise<boolean>;
  canViewList(input: JointAuthorizationInput): Promise<boolean>;
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
}
