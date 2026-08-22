import { Inject, Injectable } from '@nestjs/common';
import { RoutineInvitationStateMachine } from '../../domain/state-machines/routine-invitation-state-machine';
import type { RoutineInvitation } from '../../domain/models/routine-invitation';
import { ROUTINE_INVITATION_REPOSITORY } from '../../infrastructure/routine-invitation-repository';
import type { RoutineInvitationRepository } from '../../infrastructure/routine-invitation-repository';

/** 到期输入（系统截止任务；MEM-018、ORG-028） */
export interface ExpireRoutineInput {
  readonly routineInvitationId: string;
  /** 社团未停用冻结期限（调用方复核） */
  readonly expiryAllowed: boolean;
}

/** 有效期届满（系统截止任务；待处理→已过期；幂等；与接受/撤回竞争只一个成功） */
@Injectable()
export class ExpireRoutineInvitationCommand {
  constructor(
    @Inject(ROUTINE_INVITATION_REPOSITORY) private readonly repo: RoutineInvitationRepository,
    private readonly stateMachine: RoutineInvitationStateMachine = new RoutineInvitationStateMachine(),
  ) {}

  async execute(input: ExpireRoutineInput): Promise<RoutineInvitation | null> {
    const invitation = await this.repo.load(input.routineInvitationId);
    if (invitation === null) {
      return null;
    }
    if (invitation.status === 'EXPIRED') {
      return invitation; // 幂等
    }
    if (!input.expiryAllowed || invitation.status !== 'PENDING') {
      return invitation; // 冻结或状态已变：不转换
    }
    const now = new Date().toISOString();
    const expired: RoutineInvitation = {
      ...invitation,
      status: this.stateMachine.transition('PENDING', 'EXPIRED'),
      version: invitation.version + 1,
      history: [...invitation.history, { at: now, type: 'EXPIRED', by: 'system' }],
    };
    if (!(await this.repo.compareAndSwap(invitation, expired))) {
      return invitation; // 与接受竞争失败：单胜者
    }
    return expired;
  }
}
