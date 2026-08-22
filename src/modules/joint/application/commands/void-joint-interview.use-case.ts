/**
 * 作废联合面试用例（JNT-004）。联动未接受结论进入待复核。
 */

import { JointInterview } from '../../domain/models/joint-interview';
import { JointConclusion } from '../../domain/models/joint-conclusion';
import { JointInterviewStateMachine } from '../../domain/state-machines/joint-interview.state-machine';
import { JointConclusionStateMachine } from '../../domain/state-machines/joint-conclusion.state-machine';
import type { JointRepository } from '../ports/joint-repository.port';
import type { JointAuthorizationPort } from '../ports/joint-authorization.port';
import { jointErrors } from '../errors';
import { assertOrgScope } from '../require-org-scope';

export interface VoidJointInterviewInput {
  readonly interviewId: string;
  readonly reason: string;
  readonly actingClubId: string;
  readonly actor: string;
  readonly now: Date;
}

export interface VoidJointInterviewUseCase {
  execute(input: VoidJointInterviewInput): Promise<void>;
}

export class DefaultVoidJointInterviewUseCase implements VoidJointInterviewUseCase {
  constructor(
    private readonly repository: JointRepository,
    private readonly authorization: JointAuthorizationPort,
  ) {}

  async execute(input: VoidJointInterviewInput): Promise<void> {
    if (
      !(await this.authorization.canManageInvitation({
        subjectId: input.actor,
        clubId: input.actingClubId,
        action: 'INVITE',
      }))
    ) {
      throw jointErrors.forbidden('仅授权用户可操作联合面试');
    }
    const interviewSnap = await this.repository.loadInterview(input.interviewId);
    if (interviewSnap === null) {
      throw jointErrors.notFound('联合面试');
    }
    const applicationSnap = await this.repository.loadApplication(interviewSnap.jointApplicationId);
    if (applicationSnap === null) {
      throw jointErrors.notFound('联合申请');
    }
    await assertOrgScope(this.repository, applicationSnap.jointActivityId, input.actingClubId);
    const interview = JointInterview.fromSnapshot(interviewSnap);
    if (!interview.voidInterview(new JointInterviewStateMachine(), input.reason, input.now)) {
      throw jointErrors.preconditionFailed('联合面试作废失败');
    }
    await this.repository.saveInterview(interview.toSnapshot(), interviewSnap.revisionNumber);

    const conclusionSnaps = await this.repository.loadConclusionsByApplication(
      interviewSnap.jointApplicationId,
    );
    for (const snap of conclusionSnaps) {
      if (snap.inviteStatus === 'ACCEPTED') {
        continue;
      }
      const conclusion = JointConclusion.fromSnapshot(snap);
      if (conclusion.toReview(new JointConclusionStateMachine(), input.now)) {
        await this.repository.saveConclusion(conclusion.toSnapshot(), snap.revisionNumber);
      }
    }
  }
}
