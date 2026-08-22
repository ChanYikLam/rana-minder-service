import { Inject, Injectable } from '@nestjs/common';
import { InvitationStateMachine } from '../../domain/state-machines/invitation-state-machine';
import type { Invitation } from '../../domain/models/invitation';
import { INVITATION_REPOSITORY } from '../../infrastructure/invitation-repository';
import type { InvitationRepository } from '../../infrastructure/invitation-repository';

/** 系统截止任务输入（SRS-SM-INV-001：待处理→已过期；REC-024） */
export interface ExpireInvitationInput {
  readonly invitationId: string;
  /** 调用方复核：活动/社团未因暂停冻结期限（REC-038、ORG-028） */
  readonly expiryAllowed: boolean;
}

/**
 * 有效期届满（系统截止任务；待处理→已过期）。
 *
 * - 截止任务幂等；与接受/撤回竞争只一个成功（compareAndSwap）；
 * - 暂停冻结期限时不得过期（保持待处理并顺延，由调用方冻结）。
 */
@Injectable()
export class ExpireInvitationCommand {
  constructor(
    @Inject(INVITATION_REPOSITORY) private readonly repo: InvitationRepository,
    private readonly stateMachine: InvitationStateMachine = new InvitationStateMachine(),
  ) {}

  async execute(input: ExpireInvitationInput): Promise<Invitation | null> {
    const invitation = await this.repo.load(input.invitationId);
    if (invitation === null) {
      return null;
    }
    if (invitation.status === 'EXPIRED') {
      return invitation; // 幂等
    }
    if (!input.expiryAllowed) {
      return invitation; // 期限冻结：不得到期
    }
    if (invitation.status !== 'PENDING') {
      return invitation; // 已接受/已拒绝/已撤回等：不转换
    }
    const now = new Date().toISOString();
    const expired: Invitation = {
      ...invitation,
      status: this.stateMachine.transition('PENDING', 'EXPIRED'),
      version: invitation.version + 1,
      history: [...invitation.history, { at: now, type: 'EXPIRED', by: 'system' }],
    };
    if (!(await this.repo.compareAndSwap(invitation, expired))) {
      return invitation; // 与接受/撤回竞争失败：单胜者，保持原状态
    }
    return expired;
  }
}
