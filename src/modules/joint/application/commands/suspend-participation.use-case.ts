/**
 * 紧急停用参与社团用例（JNT-002）。
 */

import { JointParticipant } from '../../domain/models/joint-participant';
import { JointParticipantStateMachine } from '../../domain/state-machines/joint-participant.state-machine';
import type { JointRepository } from '../ports/joint-repository.port';
import type { JointAuthorizationPort } from '../ports/joint-authorization.port';
import { jointErrors } from '../errors';
import { assertOrgScope } from '../require-org-scope';

export interface SuspendParticipationInput {
  readonly activityId: string;
  readonly clubId: string;
  readonly actingClubId: string;
  readonly actor: string;
  readonly now: Date;
}

export interface SuspendParticipationUseCase {
  execute(input: SuspendParticipationInput): Promise<void>;
}

export class DefaultSuspendParticipationUseCase implements SuspendParticipationUseCase {
  constructor(
    private readonly repository: JointRepository,
    private readonly authorization: JointAuthorizationPort,
  ) {}

  async execute(input: SuspendParticipationInput): Promise<void> {
    const participantId = JointParticipant.participantId(input.activityId, input.clubId);
    const participantSnap = await this.repository.loadParticipant(participantId);
    if (participantSnap === null) {
      throw jointErrors.notFound('参与社团关系');
    }

    await assertOrgScope(this.repository, input.activityId, input.actingClubId);

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
    if (!participant.suspend(new JointParticipantStateMachine(), input.now)) {
      throw jointErrors.preconditionFailed('参与社团紧急停用失败');
    }
    await this.repository.saveParticipant(participant.toSnapshot(), participantSnap.revisionNumber);
  }
}
