/**
 * 处理邀请拒绝用例（JNT-005）。
 */

import { JointConclusion } from '../../domain/models/joint-conclusion';
import type { JointRepository } from '../ports/joint-repository.port';
import { jointErrors } from '../errors';

export interface HandleInvitationRejectedInput {
  readonly conclusionId: string;
  readonly invitationId: string;
  readonly now: Date;
}

export interface HandleInvitationRejectedUseCase {
  execute(input: HandleInvitationRejectedInput): Promise<void>;
}

export class DefaultHandleInvitationRejectedUseCase implements HandleInvitationRejectedUseCase {
  constructor(private readonly repository: JointRepository) {}

  async execute(input: HandleInvitationRejectedInput): Promise<void> {
    const conclusionSnap = await this.repository.loadConclusion(input.conclusionId);
    if (conclusionSnap === null) {
      throw jointErrors.notFound('社团结论');
    }
    if (conclusionSnap.inviteStatus !== 'PENDING') {
      return;
    }
    const conclusion = JointConclusion.fromSnapshot(conclusionSnap);
    if (conclusionSnap.invitationId !== input.invitationId) {
      throw jointErrors.forbidden('邀请标识与结论不一致');
    }
    conclusion.markInviteRejected(input.now);
    await this.repository.saveConclusion(conclusion.toSnapshot(), conclusionSnap.revisionNumber);
  }
}
