/**
 * 恢复参与社团用例（JNT-002）。按停用时长顺延。
 */

import { JointParticipant } from '../../domain/models/joint-participant';
import { JointParticipantStateMachine } from '../../domain/state-machines/joint-participant.state-machine';
import type { JointRepository } from '../ports/joint-repository.port';
import type { JointAuthorizationPort } from '../ports/joint-authorization.port';
import { jointErrors } from '../errors';
import { assertOrgScope } from '../require-org-scope';

export interface ResumeParticipationInput {
  readonly activityId: string;
  readonly clubId: string;
  readonly actingClubId: string;
  readonly actor: string;
  readonly suspendedForMs: number;
  readonly now: Date;
}

export interface ResumeParticipationUseCase {
  execute(input: ResumeParticipationInput): Promise<void>;
}

export class DefaultResumeParticipationUseCase implements ResumeParticipationUseCase {
  constructor(
    private readonly repository: JointRepository,
    private readonly authorization: JointAuthorizationPort,
  ) {}

  async execute(input: ResumeParticipationInput): Promise<void> {
    const participantId = JointParticipant.participantId(input.activityId, input.clubId);
    const participantSnap = await this.repository.loadParticipant(participantId);
    if (participantSnap === null) {
      throw jointErrors.notFound('参与社团关系');
    }

    await assertOrgScope(this.repository, input.activityId, input.actingClubId);

    if (input.clubId !== input.actingClubId) {
      throw jointErrors.forbidden('仅能操作本组织参与关系');
    }

    if (
      !(await this.authorization.canManageParticipation({
        activityId: input.activityId,
        subjectId: input.actor,
        clubId: input.actingClubId,
        action: 'MANAGE_PARTICIPATION',
      }))
    ) {
      throw jointErrors.forbidden('仅授权用户可管理参与社团');
    }

    const participant = JointParticipant.fromSnapshot(participantSnap);
    if (!participant.resume(new JointParticipantStateMachine(), input.suspendedForMs, input.now)) {
      throw jointErrors.preconditionFailed('参与社团恢复失败');
    }
    await this.repository.saveParticipant(participant.toSnapshot(), participantSnap.revisionNumber);
  }
}
