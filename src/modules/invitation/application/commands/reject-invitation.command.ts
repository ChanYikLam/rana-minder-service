import { Inject, Injectable } from '@nestjs/common';
import { InvitationStateMachine } from '../../domain/state-machines/invitation-state-machine';
import type { Invitation } from '../../domain/models/invitation';
import { InvitationPolicy } from '../../domain/services/invitation-policy';
import { INVITATION_REPOSITORY } from '../../infrastructure/invitation-repository';
import type { InvitationRepository } from '../../infrastructure/invitation-repository';

/** 拒绝邀请输入（SRS-SM-INV-001：待处理→已拒绝；REC-024） */
export interface RejectInvitationInput {
  readonly invitationId: string;
  readonly principalId: string;
}

/** 前置失败（IFC-ERR-003/006/007） */
export class RejectInvitationError extends Error {
  readonly code: 'IFC-ERR-003' | 'IFC-ERR-006' | 'IFC-ERR-007';
  constructor(code: 'IFC-ERR-003' | 'IFC-ERR-006' | 'IFC-ERR-007', message: string) {
    super(`${code}: ${message}`);
    this.name = 'RejectInvitationError';
    this.code = code;
  }
}

/**
 * 申请人拒绝（SRS-SM-INV-001：待处理→已拒绝）。
 *
 * - 仅邀请指定本人；仅待处理可拒绝；
 * - 仅记录拒绝终态并保留不可变历史（旧邀请不修改）；
 *   拒绝后如需继续招募，由调用方基于新资格调用 {@link ReissueInvitationCommand}
 *   创建全新邀请对象（REC-024 拒绝后可重发），本命令不自动重发；
 * - 与接受/撤回/过期竞争只一个成功（compareAndSwap）。
 */
@Injectable()
export class RejectInvitationCommand {
  constructor(
    @Inject(INVITATION_REPOSITORY) private readonly repo: InvitationRepository,
    private readonly policy: InvitationPolicy,
    private readonly stateMachine: InvitationStateMachine = new InvitationStateMachine(),
  ) {}

  async execute(input: RejectInvitationInput): Promise<Invitation> {
    const invitation = await this.repo.load(input.invitationId);
    if (invitation === null) {
      throw new RejectInvitationError('IFC-ERR-006', '邀请不存在');
    }
    // 先校验本人（非本人不得读取/操作终态邀请）
    this.policy.assertIsInvitee(input.principalId, invitation.inviteeId);
    if (invitation.status === 'REJECTED') {
      return invitation; // 幂等（本人重复拒绝）
    }
    if (!this.stateMachine.canTransition(invitation.status, 'REJECTED')) {
      throw new RejectInvitationError('IFC-ERR-007', '邀请不在待处理状态，无法拒绝');
    }
    const now = new Date().toISOString();
    const rejected: Invitation = {
      ...invitation,
      status: this.stateMachine.transition(invitation.status, 'REJECTED'),
      version: invitation.version + 1,
      history: [...invitation.history, { at: now, type: 'REJECTED', by: input.principalId }],
    };
    if (!(await this.repo.compareAndSwap(invitation, rejected))) {
      throw new RejectInvitationError('IFC-ERR-007', '邀请状态已被并发变更，拒绝失败');
    }
    return rejected;
  }
}
