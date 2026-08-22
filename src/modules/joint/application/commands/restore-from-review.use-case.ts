/**
 * 待复核恢复邀请用例（JNT-005）。沿用原冻结剩余时长。
 */

import { JointConclusion } from '../../domain/models/joint-conclusion';
import { JointConclusionStateMachine } from '../../domain/state-machines/joint-conclusion.state-machine';
import type { JointRepository } from '../ports/joint-repository.port';
import type { JointInvitationPort } from '../ports/joint-invitation.port';
import type { JointAuthorizationPort } from '../ports/joint-authorization.port';
import { jointErrors } from '../errors';

export interface RestoreFromReviewInput {
  readonly conclusionId: string;
  readonly subjectId: string;
  readonly now: Date;
}

export interface RestoreFromReviewUseCase {
  execute(input: RestoreFromReviewInput): Promise<void>;
}

export class DefaultRestoreFromReviewUseCase implements RestoreFromReviewUseCase {
  constructor(
    private readonly repository: JointRepository,
    private readonly invitation: JointInvitationPort,
    private readonly authorization: JointAuthorizationPort,
  ) {}

  async execute(input: RestoreFromReviewInput): Promise<void> {
    const conclusionSnap = await this.repository.loadConclusion(input.conclusionId);
    if (conclusionSnap === null) {
      throw jointErrors.notFound('社团结论');
    }
    if (
      !(await this.authorization.canRestoreReview({
        subjectId: input.subjectId,
        activityId: conclusionSnap.jointActivityId,
        clubId: conclusionSnap.clubId,
        action: 'RESTORE_REVIEW',
      }))
    ) {
      throw jointErrors.forbidden('无权恢复该社团结论邀请');
    }
    if (conclusionSnap.status !== 'REVIEW_PENDING') {
      throw jointErrors.preconditionFailed('仅待复核态结论可恢复邀请');
    }
    const conclusion = JointConclusion.fromSnapshot(conclusionSnap);
    if (!conclusion.restoreFromReview(new JointConclusionStateMachine(), input.now)) {
      throw jointErrors.preconditionFailed('结论恢复邀请失败');
    }
    if (conclusionSnap.invitationId !== null) {
      await this.invitation.restoreFrozenInvitation(conclusionSnap.invitationId);
    }
    await this.repository.saveConclusion(conclusion.toSnapshot(), conclusionSnap.revisionNumber);
  }
}
