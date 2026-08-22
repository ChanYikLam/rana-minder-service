/**
 * 公布联合活动用例（JNT-001）。须全体确认且不少于两社团方可公布。
 */

import { JointActivity } from '../../domain/models/joint-activity';
import { JointParticipant } from '../../domain/models/joint-participant';
import { JointActivityStateMachine } from '../../domain/state-machines/joint-activity.state-machine';
import { JointParticipantStateMachine } from '../../domain/state-machines/joint-participant.state-machine';
import type { JointRepository } from '../ports/joint-repository.port';
import type { JointAuthorizationPort } from '../ports/joint-authorization.port';
import { jointErrors } from '../errors';
import { assertOrgScope } from '../require-org-scope';

export interface PublishJointActivityInput {
  readonly activityId: string;
  readonly actingClubId: string;
  readonly actor: string;
  readonly now: Date;
}

export interface PublishJointActivityUseCase {
  execute(input: PublishJointActivityInput): Promise<void>;
}

export class DefaultPublishJointActivityUseCase implements PublishJointActivityUseCase {
  constructor(
    private readonly repository: JointRepository,
    private readonly authorization: JointAuthorizationPort,
  ) {}

  async execute(input: PublishJointActivityInput): Promise<void> {
    const activitySnap = await this.repository.loadActivity(input.activityId);
    if (activitySnap === null) {
      throw jointErrors.notFound('联合活动');
    }

    await assertOrgScope(this.repository, input.activityId, input.actingClubId);

    if (
      !(await this.authorization.canPublish({
        activityId: input.activityId,
        subjectId: input.actor,
        clubId: input.actingClubId,
        action: 'PUBLISH',
      }))
    ) {
      throw jointErrors.forbidden('仅授权用户可公布联合活动');
    }

    if (activitySnap.status !== 'ESTABLISHED') {
      throw jointErrors.preconditionFailed('仅已成立的联合活动可公布');
    }

    const participantSnaps = await this.repository.loadParticipantsByActivity(input.activityId);
    if (participantSnaps.length < 2 || !participantSnaps.every((p) => p.status === 'CONFIRMED')) {
      throw jointErrors.preconditionFailed('须全部确认且不少于两社团方可公布');
    }

    const activity = JointActivity.fromSnapshot(activitySnap);
    const activityMachine = new JointActivityStateMachine();
    if (!activity.publish(activityMachine, input.now)) {
      throw jointErrors.preconditionFailed('联合活动公布失败');
    }
    await this.repository.saveActivity(activity.toSnapshot(), activitySnap.revisionNumber);

    const participantMachine = new JointParticipantStateMachine();
    for (const snap of participantSnaps) {
      const participant = JointParticipant.fromSnapshot(snap);
      if (!participant.participate(participantMachine, input.now)) {
        throw jointErrors.preconditionFailed('参与社团固化失败');
      }
      await this.repository.saveParticipant(participant.toSnapshot(), snap.revisionNumber);
    }
  }
}
