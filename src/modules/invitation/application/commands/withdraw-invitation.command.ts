import { Inject, Injectable } from '@nestjs/common';
import { InvitationStateMachine } from '../../domain/state-machines/invitation-state-machine';
import type { Invitation } from '../../domain/models/invitation';
import { InvitationPolicy } from '../../domain/services/invitation-policy';
import { INVITATION_REPOSITORY } from '../../infrastructure/invitation-repository';
import type { InvitationRepository } from '../../infrastructure/invitation-repository';

/** 撤回邀请输入（SRS-SM-INV-001：待处理→已撤回；REC-024） */
export interface WithdrawInvitationInput {
  readonly invitationId: string;
  readonly principalId: string;
  readonly principalRoles: readonly string[];
}

/** 前置失败（IFC-ERR-003/006/007） */
export class WithdrawInvitationError extends Error {
  constructor(code: 'IFC-ERR-003' | 'IFC-ERR-006' | 'IFC-ERR-007', message: string) {
    super(`${code}: ${message}`);
    this.name = 'WithdrawInvitationError';
  }
}

/**
 * 发出方撤回（SRS-SM-INV-001：待处理→已撤回；REC-024）。
 *
 * - 仅负责人/人事（部门负责人无权）；
 * - 仅待处理可撤回（与接受并发只一个成功）；已接受不可撤回；
 * - 撤回事件保存、旧邀请永久保留（不得复活）。
 */
@Injectable()
export class WithdrawInvitationCommand {
  constructor(
    @Inject(INVITATION_REPOSITORY) private readonly repo: InvitationRepository,
    private readonly policy: InvitationPolicy,
    private readonly stateMachine: InvitationStateMachine = new InvitationStateMachine(),
  ) {}

  async execute(input: WithdrawInvitationInput): Promise<Invitation> {
    this.policy.assertCanIssue(input.principalRoles);
    const invitation = await this.repo.load(input.invitationId);
    if (invitation === null) {
      throw new WithdrawInvitationError('IFC-ERR-006', '邀请不存在');
    }
    if (invitation.status === 'WITHDRAWN') {
      return invitation; // 幂等
    }
    if (invitation.status !== 'PENDING') {
      throw new WithdrawInvitationError('IFC-ERR-007', '仅待处理邀请可撤回');
    }
    const now = new Date().toISOString();
    const withdrawn: Invitation = {
      ...invitation,
      status: this.stateMachine.transition('PENDING', 'WITHDRAWN'),
      version: invitation.version + 1,
      history: [...invitation.history, { at: now, type: 'WITHDRAWN', by: input.principalId }],
    };
    if (!(await this.repo.compareAndSwap(invitation, withdrawn))) {
      throw new WithdrawInvitationError('IFC-ERR-007', '邀请状态已被并发变更，撤回失败');
    }
    return withdrawn;
  }
}
