/**
 * 确认本轮参与用例（JNT-002）。全部确认且活动待确认态时推进活动成立。
 */

import { JointActivity } from '../../domain/models/joint-activity';
import { JointParticipant } from '../../domain/models/joint-participant';
import { JointActivityStateMachine } from '../../domain/state-machines/joint-activity.state-machine';
import { JointParticipantStateMachine } from '../../domain/state-machines/joint-participant.state-machine';
import type { JointRepository } from '../ports/joint-repository.port';
import type { JointAuthorizationPort } from '../ports/joint-authorization.port';
import { jointErrors } from '../errors';
import { assertOrgScope } from '../require-org-scope';

export interface ConfirmParticipationRoundInput {
  readonly activityId: string;
  readonly clubId: string;
  readonly actingClubId: string;
  readonly actor: string;
  readonly now: Date;
}

export interface ConfirmParticipationRoundUseCase {
  execute(input: ConfirmParticipationRoundInput): Promise<void>;
}

export class DefaultConfirmParticipationRoundUseCase implements ConfirmParticipationRoundUseCase {
  constructor(
    private readonly repository: JointRepository,
    private readonly authorization: JointAuthorizationPort,
  ) {}

  async execute(input: ConfirmParticipationRoundInput): Promise<void> {
    const activitySnap = await this.repository.loadActivity(input.activityId);
    if (activitySnap === null) {
      throw jointErrors.notFound('联合活动');
    }
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
      !(await this.authorization.canConfirmRound({
        activityId: input.activityId,
        subjectId: input.actor,
        clubId: input.actingClubId,
        action: 'CONFIRM_ROUND',
      }))
    ) {
      throw jointErrors.forbidden('仅授权用户可确认本轮参与');
    }

    const activity = JointActivity.fromSnapshot(activitySnap);
    if (activity.firstInvitationAt !== null) {
      throw jointErrors.forbidden('已存在首邀，禁止确认本轮参与');
    }

    const participant = JointParticipant.fromSnapshot(participantSnap);
    const machine = new JointParticipantStateMachine();
    // 待重确认（STALE_RECONFIRM）的社团在轮次一致时走重新确认，而非新建；
    // 拟参与（PROPOSED）走首次确认。
    if (participantSnap.status === 'STALE_RECONFIRM') {
      if (!participant.reconfirm(machine, activity.confirmRound, input.actor, input.now)) {
        throw jointErrors.preconditionFailed('参与社团重新确认失败');
      }
    } else if (!participant.confirm(machine, activity.confirmRound, input.actor, input.now)) {
      throw jointErrors.preconditionFailed('参与社团确认失败');
    }
    await this.repository.saveParticipant(participant.toSnapshot(), participantSnap.revisionNumber);

    const participants = await this.repository.loadParticipantsByActivity(input.activityId);
    const allConfirmed =
      participants.length > 0 && participants.every((p) => p.status === 'CONFIRMED');
    if (allConfirmed && activity.status === 'DRAFT_CONFIRMING') {
      if (activity.confirmAll(new JointActivityStateMachine(), input.now)) {
        await this.repository.saveActivity(activity.toSnapshot(), activitySnap.revisionNumber);
      }
    }
  }
}
