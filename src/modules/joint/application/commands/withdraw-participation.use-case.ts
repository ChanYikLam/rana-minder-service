/**
 * 撤回拟参与用例（JNT-002）。
 */

import { JointParticipant } from '../../domain/models/joint-participant';
import { JointParticipantStateMachine } from '../../domain/state-machines/joint-participant.state-machine';
import type { JointRepository } from '../ports/joint-repository.port';
import type { JointAuthorizationPort } from '../ports/joint-authorization.port';
import { jointErrors } from '../errors';
import { assertOrgScope } from '../require-org-scope';

export interface WithdrawParticipationInput {
  readonly activityId: string;
  readonly clubId: string;
  readonly actingClubId: string;
  readonly actor: string;
  readonly now: Date;
}

export interface WithdrawParticipationUseCase {
  execute(input: WithdrawParticipationInput): Promise<void>;
}

export class DefaultWithdrawParticipationUseCase implements WithdrawParticipationUseCase {
  constructor(
    private readonly repository: JointRepository,
    private readonly authorization: JointAuthorizationPort,
  ) {}

  async execute(input: WithdrawParticipationInput): Promise<void> {
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
    if (!participant.withdraw(new JointParticipantStateMachine(), input.now)) {
      throw jointErrors.preconditionFailed('拟参与撤回失败');
    }
    await this.repository.saveParticipant(participant.toSnapshot(), participantSnap.revisionNumber);
  }
}
