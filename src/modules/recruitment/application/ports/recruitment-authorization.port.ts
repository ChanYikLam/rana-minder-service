/**
 * 招新授权端口（recruitment 应用层；依赖 3.x 身份/组织授权，当前未实现）。
 *
 * fail-closed：默认拒绝，待 3.x Casdoor 统一适配接入后由真实实现替换（同 4.1 策略）。
 */

export interface RecruitmentAuthorizationInput {
  readonly clubId: string;
  readonly subjectId: string;
  readonly activityId?: string;
}

export interface RecruitmentAuthorizationPort {
  /** 负责人/人事可管理本社团招新（建活动、配通道、发邀请等） */
  canManageRecruitment(input: RecruitmentAuthorizationInput): Promise<boolean>;
  /** 提交申请资格（账号有效、非当前成员、批次资格快照通过等，由 3.x 判定） */
  canSubmitApplication(input: RecruitmentAuthorizationInput): Promise<boolean>;
}

export class NotWiredRecruitmentAuthorization implements RecruitmentAuthorizationPort {
  async canManageRecruitment(): Promise<boolean> {
    return false;
  }
  async canSubmitApplication(): Promise<boolean> {
    return false;
  }
}
