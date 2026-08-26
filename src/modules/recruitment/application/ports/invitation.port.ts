/**
 * 跨模块邀请端口（recruitment → invitation；4.4b 收口）。
 *
 * 职责：普通招新"录取邀请"创建时，把领域内 SEND_INVITATION 事件收敛为
 * 邀请模块的真实 INV-001 邀请对象（REC-024/REC-045），从而打通
 * "招新录取 → 邀请 → 接受 → 成员激活" 的核心链路（原为本地状态机桩，
 * 未真正创建邀请对象）。
 *
 * 约定：
 * - 仅当录取邀请在 recruitment 领域内成功（SUBMITTED → ADMITTED）后调用；
 * - 幂等：邀请模块 CreateInvitationCommand 自身保证"同社团同对象最多一份
 *   待处理邀请"（IFC-ERR-009），重复调用由邀请域收敛；
 * - 失败不得伪造成功：端口抛错应上抛，由调用方按事务边界处理。
 */
export interface CreateAdmissionInvitationInput {
  readonly issuerId: string;
  readonly issuerClubId: string;
  readonly inviteeId: string;
  readonly clubId: string;
  /** 已复核部门录取决定（REC-045 复核前置） */
  readonly decisionRef: string;
  readonly expiresAt: string;
}

export interface InvitationPort {
  createAdmissionInvitation(input: CreateAdmissionInvitationInput): Promise<void>;
}

/** 未接线时的失败关闭桩（防止静默不创建邀请） */
export class NotWiredInvitationPort implements InvitationPort {
  async createAdmissionInvitation(_input: CreateAdmissionInvitationInput): Promise<void> {
    throw new Error('IFC-ERR-015: 邀请端口未接线，无法创建录取邀请');
  }
}
