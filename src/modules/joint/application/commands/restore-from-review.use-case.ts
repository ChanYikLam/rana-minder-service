/**
 * 待复核恢复邀请用例（JNT-005）。沿用原冻结剩余时长。
 */

import { JointConclusion } from '../../domain/models/joint-conclusion';
import { JointConclusionStateMachine } from '../../domain/state-machines/joint-conclusion.state-machine';
import type { JointRepository } from '../ports/joint-repository.port';
import type { JointInvitationPort } from '../ports/joint-invitation.port';
import type { JointAuthorizationPort } from '../ports/joint-authorization.port';
import { jointErrors } from '../errors';
import {
  INVITATION_TIMEOUT_DEFAULT_MS,
  type JointTaskEnqueuer,
} from '../../infrastructure/joint-task-enqueuer';

export interface RestoreFromReviewInput {
  readonly conclusionId: string;
  readonly actingClubId: string;
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
    private readonly tasks: JointTaskEnqueuer,
  ) {}

  async execute(input: RestoreFromReviewInput): Promise<void> {
    const conclusionSnap = await this.repository.loadConclusion(input.conclusionId);
    if (conclusionSnap === null) {
      throw jointErrors.notFound('社团结论');
    }
    if (input.actingClubId !== conclusionSnap.clubId) {
      throw jointErrors.forbidden('仅可操作本组织的社团结论');
    }
    if (
      !(await this.authorization.canRestoreReview({
        subjectId: input.subjectId,
        activityId: conclusionSnap.jointActivityId,
        clubId: input.actingClubId,
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
      // 恢复后重新调度邀请超时，否则原超时任务已触发（超时/作废场景）后
      // 恢复的邀请将永不再超时；复用 invitationId 作为幂等键。
      const notBefore = new Date(input.now.getTime() + INVITATION_TIMEOUT_DEFAULT_MS);
      await this.tasks.scheduleInvitationTimeout(
        conclusionSnap.jointActivityId,
        conclusion.toSnapshot().revisionNumber,
        conclusionSnap.invitationId,
        notBefore,
      );
    }
    await this.repository.saveConclusion(conclusion.toSnapshot(), conclusionSnap.revisionNumber);
  }
}
