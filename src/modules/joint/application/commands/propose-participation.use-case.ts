/**
 * 提出拟参与用例（JNT-002）。幂等：已为拟参与态直接返回。
 */

import { JointActivity } from '../../domain/models/joint-activity';
import { JointParticipant } from '../../domain/models/joint-participant';
import type { JointRepository } from '../ports/joint-repository.port';
import type { JointAuthorizationPort } from '../ports/joint-authorization.port';
import { jointErrors } from '../errors';

export interface ProposeParticipationInput {
  readonly activityId: string;
  readonly clubId: string;
  readonly actor: string;
  readonly now: Date;
  readonly id?: string;
}

export interface ProposeParticipationUseCase {
  execute(input: ProposeParticipationInput): Promise<void>;
}

export class DefaultProposeParticipationUseCase implements ProposeParticipationUseCase {
  constructor(
    private readonly repository: JointRepository,
    private readonly authorization: JointAuthorizationPort,
  ) {}

  async execute(input: ProposeParticipationInput): Promise<void> {
    const activitySnap = await this.repository.loadActivity(input.activityId);
    if (activitySnap === null) {
      throw jointErrors.notFound('联合活动');
    }
    const activity = JointActivity.fromSnapshot(activitySnap);
    activity.assertNotTerminal();

    if (
      !(await this.authorization.canManageParticipation({
        activityId: input.activityId,
        subjectId: input.actor,
        action: 'MANAGE_PARTICIPATION',
      }))
    ) {
      throw jointErrors.forbidden('仅授权用户可管理参与社团');
    }

    const participantId = JointParticipant.participantId(input.activityId, input.clubId);
    const existing = await this.repository.loadParticipant(participantId);
    if (existing !== null && existing.status === 'PROPOSED') {
      return;
    }

    const participant = JointParticipant.createProposed({
      activityId: input.activityId,
      clubId: input.clubId,
      roundId: activity.confirmRound,
      now: input.now,
    });
    await this.repository.saveParticipant(participant.toSnapshot(), -1);
  }
}
