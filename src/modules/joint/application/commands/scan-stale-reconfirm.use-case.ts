/**
 * 扫描过期需重确认参与社团用例（TASK，无授权）。返回变更数量。
 */

import { JointParticipant } from '../../domain/models/joint-participant';
import { JointParticipantStateMachine } from '../../domain/state-machines/joint-participant.state-machine';
import type { JointRepository } from '../ports/joint-repository.port';

export interface ScanStaleReconfirmInput {
  readonly activityId: string;
  readonly now: Date;
}

export interface ScanStaleReconfirmResult {
  readonly changed: number;
}

export interface ScanStaleReconfirmUseCase {
  execute(input: ScanStaleReconfirmInput): Promise<ScanStaleReconfirmResult>;
}

export class DefaultScanStaleReconfirmUseCase implements ScanStaleReconfirmUseCase {
  constructor(private readonly repository: JointRepository) {}

  async execute(input: ScanStaleReconfirmInput): Promise<ScanStaleReconfirmResult> {
    const activitySnap = await this.repository.loadActivity(input.activityId);
    if (activitySnap === null) {
      return { changed: 0 };
    }
    const participantSnaps = await this.repository.loadParticipantsByActivity(input.activityId);
    let changed = 0;
    for (const snap of participantSnaps) {
      if (snap.status !== 'CONFIRMED') {
        continue;
      }
      const stale =
        snap.roundId !== activitySnap.confirmRound ||
        (activitySnap.confirmDeadline !== null && input.now > activitySnap.confirmDeadline);
      if (!stale) {
        continue;
      }
      const participant = JointParticipant.fromSnapshot(snap);
      if (participant.markStale(new JointParticipantStateMachine(), input.now)) {
        await this.repository.saveParticipant(participant.toSnapshot(), snap.revisionNumber);
        changed += 1;
      }
    }
    return { changed };
  }
}
