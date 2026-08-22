import { Inject, Injectable } from '@nestjs/common';
import { InvitationStateMachine } from '../../domain/state-machines/invitation-state-machine';
import type { Invitation } from '../../domain/models/invitation';
import { INVITATION_REPOSITORY } from '../../infrastructure/invitation-repository';
import type { InvitationRepository } from '../../infrastructure/invitation-repository';

/** 强制失效输入（SRS-SM-INV-001：待处理→强制失效；REC-030/033、JNT-019/024） */
export interface ForceInvalidateInput {
  readonly invitationId: string;
  /** 上游终态命令来源（活动取消/普通强制完成/联合强制结束） */
  readonly source: string;
}

/**
 * 强制失效（系统随上游终态命令；待处理→强制失效）。
 *
 * - 活动取消、普通强制完成或联合强制结束使待处理邀请原子失效；
 * - **已接受邀请不受影响**（不得强制失效已接受，保持已接受）；
 * - 与接受竞争只一个成功；批量失效每邀请幂等。
 */
@Injectable()
export class ForceInvalidateInvitationCommand {
  constructor(
    @Inject(INVITATION_REPOSITORY) private readonly repo: InvitationRepository,
    private readonly stateMachine: InvitationStateMachine = new InvitationStateMachine(),
  ) {}

  async execute(input: ForceInvalidateInput): Promise<Invitation | null> {
    const invitation = await this.repo.load(input.invitationId);
    if (invitation === null) {
      return null;
    }
    if (invitation.status === 'FORCE_INVALIDATED') {
      return invitation; // 幂等
    }
    if (invitation.status === 'ACCEPTED') {
      return invitation; // 已接受不受影响（REC-030、JNT-019）
    }
    if (invitation.status !== 'PENDING') {
      return invitation; // 已拒绝/已撤回/已过期：不转换
    }
    const now = new Date().toISOString();
    const invalidated: Invitation = {
      ...invitation,
      status: this.stateMachine.transition('PENDING', 'FORCE_INVALIDATED'),
      version: invitation.version + 1,
      history: [
        ...invitation.history,
        { at: now, type: 'FORCE_INVALIDATED', by: 'system', note: input.source },
      ],
    };
    if (!(await this.repo.compareAndSwap(invitation, invalidated))) {
      return invitation; // 与接受竞争失败：单胜者
    }
    return invalidated;
  }
}
