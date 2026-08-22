/**
 * 列出联合活动参与社团用例（JNT-002）。
 */

import { JointParticipant } from '../../domain/models/joint-participant';
import type { JointRepository } from '../ports/joint-repository.port';

export interface ListJointParticipantsInput {
  readonly activityId: string;
}

export interface ListJointParticipantsUseCase {
  execute(input: ListJointParticipantsInput): Promise<JointParticipant[]>;
}

export class DefaultListJointParticipantsUseCase implements ListJointParticipantsUseCase {
  constructor(private readonly repository: JointRepository) {}

  async execute(input: ListJointParticipantsInput): Promise<JointParticipant[]> {
    const snaps = await this.repository.loadParticipantsByActivity(input.activityId);
    return snaps.map((s) => JointParticipant.fromSnapshot(s));
  }
}
