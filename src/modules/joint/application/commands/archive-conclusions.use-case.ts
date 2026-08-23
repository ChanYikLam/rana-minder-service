/**
 * 归档社团结论用例（TASK，无授权）。非终态锁定结论全部归档。
 */

import { JointConclusion } from '../../domain/models/joint-conclusion';
import { JointConclusionStateMachine } from '../../domain/state-machines/joint-conclusion.state-machine';
import type { JointRepository } from '../ports/joint-repository.port';

export interface ArchiveConclusionsInput {
  readonly activityId: string;
  readonly now: Date;
}

export interface ArchiveConclusionsUseCase {
  execute(input: ArchiveConclusionsInput): Promise<void>;
}

export class DefaultArchiveConclusionsUseCase implements ArchiveConclusionsUseCase {
  constructor(private readonly repository: JointRepository) {}

  async execute(input: ArchiveConclusionsInput): Promise<void> {
    const conclusionSnaps = await this.repository.loadConclusionsByActivity(input.activityId);
    for (const snap of conclusionSnaps) {
      if (snap.status === 'ARCHIVED_LOCKED') {
        continue;
      }
      const conclusion = JointConclusion.fromSnapshot(snap);
      if (conclusion.archive(new JointConclusionStateMachine(), input.now)) {
        await this.repository.saveConclusion(conclusion.toSnapshot(), snap.revisionNumber);
      }
    }
  }
}
