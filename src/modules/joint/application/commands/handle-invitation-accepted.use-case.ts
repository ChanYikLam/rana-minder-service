/**
 * 处理邀请接受用例（JNT-005）。立即锁定社团结论。
 */

import { JointConclusion } from '../../domain/models/joint-conclusion';
import { JointConclusionStateMachine } from '../../domain/state-machines/joint-conclusion.state-machine';
import type { JointRepository } from '../ports/joint-repository.port';
import { jointErrors } from '../errors';

export interface HandleInvitationAcceptedInput {
  readonly conclusionId: string;
  readonly invitationId: string;
  readonly now: Date;
}

export interface HandleInvitationAcceptedUseCase {
  execute(input: HandleInvitationAcceptedInput): Promise<void>;
}

export class DefaultHandleInvitationAcceptedUseCase implements HandleInvitationAcceptedUseCase {
  constructor(private readonly repository: JointRepository) {}

  async execute(input: HandleInvitationAcceptedInput): Promise<void> {
    const conclusionSnap = await this.repository.loadConclusion(input.conclusionId);
    if (conclusionSnap === null) {
      throw jointErrors.notFound('社团结论');
    }
    if (conclusionSnap.inviteStatus !== 'PENDING') {
      return;
    }
    if (conclusionSnap.invitationId !== input.invitationId) {
      throw jointErrors.forbidden('邀请标识与结论不一致');
    }
    const conclusion = JointConclusion.fromSnapshot(conclusionSnap);
    if (!conclusion.markInviteAccepted(new JointConclusionStateMachine(), input.now)) {
      throw jointErrors.preconditionFailed('邀请接受处理失败');
    }
    await this.repository.saveConclusion(conclusion.toSnapshot(), conclusionSnap.revisionNumber);
  }
}
