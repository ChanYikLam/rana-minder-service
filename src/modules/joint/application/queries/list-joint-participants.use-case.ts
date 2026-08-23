/**
 * 列出联合活动参与社团用例（JNT-002）。
 */

import { JointParticipant } from '../../domain/models/joint-participant';
import type { JointRepository } from '../ports/joint-repository.port';
import type { JointAuthorizationPort } from '../ports/joint-authorization.port';
import { jointErrors } from '../errors';

export interface ListJointParticipantsInput {
  readonly activityId: string;
  readonly subjectId: string;
  readonly clubId: string;
}

export interface ListJointParticipantsUseCase {
  execute(input: ListJointParticipantsInput): Promise<JointParticipant[]>;
}

export class DefaultListJointParticipantsUseCase implements ListJointParticipantsUseCase {
  constructor(
    private readonly repository: JointRepository,
    private readonly authorization: JointAuthorizationPort,
  ) {}

  async execute(input: ListJointParticipantsInput): Promise<JointParticipant[]> {
    if (
      !(await this.authorization.canViewParticipants({
        subjectId: input.subjectId,
        activityId: input.activityId,
        clubId: input.clubId,
        action: 'VIEW_PARTICIPANTS',
      }))
    ) {
      throw jointErrors.forbidden('无权查看该联合活动参与社团');
    }
    const snaps = await this.repository.loadParticipantsByActivity(input.activityId);
    return snaps.map((s) => JointParticipant.fromSnapshot(s));
  }
}
