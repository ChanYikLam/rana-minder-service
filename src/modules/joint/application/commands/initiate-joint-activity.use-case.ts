/**
 * 发起联合活动用例（JNT-001）。
 *
 * 至少两个拟参与社团，fail-closed 授权桩默认拒绝（待 3.x 接入）。
 */

import { randomUUID } from 'node:crypto';
import { JointActivity } from '../../domain/models/joint-activity';
import { JointParticipant } from '../../domain/models/joint-participant';
import { JointChannel } from '../../domain/models/joint-channel';
import type { JointRepository } from '../ports/joint-repository.port';
import type { JointAuthorizationPort } from '../ports/joint-authorization.port';
import { jointErrors } from '../errors';
import type { JointTaskEnqueuer } from '../../infrastructure/joint-task-enqueuer';

export interface InitiateJointActivityInput {
  readonly title: string;
  readonly description?: string | null;
  readonly confirmDeadline: Date;
  readonly clubIds: string[];
  readonly actingClubId: string;
  readonly actor: string;
  readonly now: Date;
  readonly id?: string;
}

export interface InitiateJointActivityResult {
  readonly activityId: string;
}

export interface InitiateJointActivityUseCase {
  execute(input: InitiateJointActivityInput): Promise<InitiateJointActivityResult>;
}

export class DefaultInitiateJointActivityUseCase implements InitiateJointActivityUseCase {
  constructor(
    private readonly repository: JointRepository,
    private readonly authorization: JointAuthorizationPort,
    private readonly tasks: JointTaskEnqueuer,
  ) {}

  async execute(input: InitiateJointActivityInput): Promise<InitiateJointActivityResult> {
    if (
      !(await this.authorization.canInitiateJoint({
        subjectId: input.actor,
        clubId: input.actingClubId,
        action: 'INITIATE',
      }))
    ) {
      throw jointErrors.forbidden('仅授权用户可发起联合活动');
    }
    if (!Array.isArray(input.clubIds) || input.clubIds.length < 2) {
      throw jointErrors.validation('联合活动至少须有两个拟参与社团');
    }
    if (!input.clubIds.includes(input.actingClubId)) {
      throw jointErrors.forbidden('发起组织须为联合活动的参与社团之一');
    }
    const id = input.id ?? randomUUID();
    const activity = JointActivity.createDraft({
      id,
      title: input.title,
      description: input.description,
      confirmDeadline: input.confirmDeadline,
      createdBy: input.actor,
      now: input.now,
    });
    await this.repository.saveActivity(activity.toSnapshot(), -1);

    for (const clubId of input.clubIds) {
      const participant = JointParticipant.createProposed({
        activityId: id,
        clubId,
        roundId: activity.confirmRound,
        now: input.now,
      });
      await this.repository.saveParticipant(participant.toSnapshot(), -1);
    }

    const channel = JointChannel.createClosed({ jointActivityId: id, now: input.now });
    await this.repository.saveChannel(channel.toSnapshot(), -1);

    const activitySnap = activity.toSnapshot();
    await this.tasks.scheduleConfirmDeadlineScan(
      id,
      activitySnap.revisionNumber,
      input.confirmDeadline,
    );

    return { activityId: id };
  }
}
