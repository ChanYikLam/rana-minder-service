/**
 * 联合邀请端口（joint 应用层；复用 INV-001 录取/加入邀请，JNT-005/6.x）。
 *
 * 依赖远程分支 feat-invitation-4-5-1-recruit（5f3848c）的 INV-001 扩展：
 * scope=JOINT + jointActivityId + 剩余时长冻结（freezeRemainingDuration）。
 * 此处仅声明联合域所需的最小端口表面，实现在基础设施层经 HTTP/gRPC 适配。
 */

export type JointInvitationDecision = 'ACCEPTED' | 'REJECTED' | 'PENDING';

export interface JointInvitationRequest {
  readonly jointActivityId: string;
  readonly jointApplicationId: string;
  readonly clubId: string;
  readonly applicantId: string;
  readonly decision: 'ADMIT' | 'TRANSFER' | 'REJECT';
  /** 冻结的剩余时长（ms）：邀请待处理期间冻结，过期自动恢复 */
  readonly freezeRemainingMs?: number;
}

export interface JointInvitationResult {
  readonly invitationId: string;
  readonly status: JointInvitationDecision;
  /** 接受后该社团结论立即锁定 */
  readonly acceptedAt: Date | null;
}

export interface JointInvitationStatus {
  readonly invitationId: string;
  readonly status: JointInvitationDecision;
  readonly acceptedAt: Date | null;
}

export interface JointInvitationPort {
  sendJointInvitation(req: JointInvitationRequest): Promise<JointInvitationResult>;
  getInvitationStatus(invitationId: string): Promise<JointInvitationStatus | null>;
  /** 面试作废后恢复邀请时沿用原冻结剩余时长 */
  restoreFrozenInvitation(invitationId: string): Promise<JointInvitationResult>;
}

export class NotWiredJointInvitation implements JointInvitationPort {
  async sendJointInvitation(): Promise<JointInvitationResult> {
    throw new Error('JNT-ERR: 联合邀请端口未接入（fail-closed）');
  }
  async getInvitationStatus(): Promise<JointInvitationStatus | null> {
    return null;
  }
  async restoreFrozenInvitation(): Promise<JointInvitationResult> {
    throw new Error('JNT-ERR: 联合邀请端口未接入（fail-closed）');
  }
}
