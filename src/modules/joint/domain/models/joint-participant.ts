/**
 * 参与社团关系聚合（JNT-002）。id 派生自 activityId:clubId，确认须匹配活动当前确认轮次。
 *
 * 不变量：公布后固化正式参与，不可新增/退出/替换；紧急停用不删除身份，恢复按停用时长顺延。
 */

import {
  JointParticipantStatus,
  JointParticipantStateMachine,
  JointParticipantEvent,
} from '../state-machines/joint-participant.state-machine';
import { JointDomainError } from '../errors';

export interface JointParticipantSnapshot {
  readonly id: string;
  readonly activityId: string;
  readonly clubId: string;
  /** 本确认所属的确认轮次；须等于活动当前 confirmRound 才有效 */
  readonly roundId: number;
  readonly status: JointParticipantStatus;
  readonly decidedBy: string | null;
  readonly confirmedAt: Date | null;
  readonly suspendedAt: Date | null;
  readonly resumedAt: Date | null;
  /** 累计停用结算时长（ms），顺延只结算一次 */
  readonly suspendedForMs: number;
  readonly revisionNumber: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export class JointParticipant {
  private constructor(private snapshot: JointParticipantSnapshot) {}

  static fromSnapshot(snapshot: JointParticipantSnapshot): JointParticipant {
    return new JointParticipant(snapshot);
  }

  static participantId(activityId: string, clubId: string): string {
    return `participant:${activityId}:${clubId}`;
  }

  static createProposed(input: {
    activityId: string;
    clubId: string;
    roundId: number;
    now: Date;
  }): JointParticipant {
    return new JointParticipant({
      id: JointParticipant.participantId(input.activityId, input.clubId),
      activityId: input.activityId,
      clubId: input.clubId,
      roundId: input.roundId,
      status: JointParticipantStatus.PROPOSED,
      decidedBy: null,
      confirmedAt: null,
      suspendedAt: null,
      resumedAt: null,
      suspendedForMs: 0,
      revisionNumber: 1,
      createdAt: input.now,
      updatedAt: input.now,
    });
  }

  get id(): string {
    return this.snapshot.id;
  }
  get activityId(): string {
    return this.snapshot.activityId;
  }
  get clubId(): string {
    return this.snapshot.clubId;
  }
  get status(): JointParticipantStatus {
    return this.snapshot.status;
  }
  get roundId(): number {
    return this.snapshot.roundId;
  }

  toSnapshot(): JointParticipantSnapshot {
    return { ...this.snapshot };
  }

  /** 确认：须匹配活动当前确认轮次，否则视为旧轮次确认（由调用方校验后调 stale） */
  confirm(
    machine: JointParticipantStateMachine,
    currentRound: number,
    actor: string,
    now: Date,
  ): boolean {
    if (this.snapshot.roundId !== currentRound) {
      throw new JointDomainError(
        'JNT_PART_ROUND_MISMATCH',
        '确认轮次与活动当前轮次不一致，旧确认已失效',
      );
    }
    this.assertProposed();
    const ok = this.transition(machine, JointParticipantEvent.CONFIRM, now);
    if (ok) {
      this.snapshot = { ...this.snapshot, decidedBy: actor, confirmedAt: now };
    }
    return ok;
  }

  markStale(machine: JointParticipantStateMachine, now: Date): boolean {
    if (this.snapshot.status !== JointParticipantStatus.CONFIRMED) {
      return false;
    }
    return this.transition(machine, JointParticipantEvent.STALE, now);
  }

  participate(machine: JointParticipantStateMachine, now: Date): boolean {
    return this.transition(machine, JointParticipantEvent.PARTICIPATE, now);
  }

  withdraw(machine: JointParticipantStateMachine, now: Date): boolean {
    this.assertProposed();
    return this.transition(machine, JointParticipantEvent.WITHDRAW, now);
  }

  /** 撤回后重新提出拟参与：WITHDRAWN → PROPOSED（同一活动+社团唯一聚合，不新建冲突行） */
  repropose(machine: JointParticipantStateMachine, now: Date): boolean {
    return this.transition(machine, JointParticipantEvent.REPROPOSE, now);
  }

  suspend(machine: JointParticipantStateMachine, now: Date): boolean {
    const ok = this.transition(machine, JointParticipantEvent.SUSPEND, now);
    if (ok) {
      this.snapshot = { ...this.snapshot, suspendedAt: now };
    }
    return ok;
  }

  resume(machine: JointParticipantStateMachine, suspendedForMs: number, now: Date): boolean {
    const ok = this.transition(machine, JointParticipantEvent.RESUME, now);
    if (ok) {
      this.snapshot = {
        ...this.snapshot,
        resumedAt: now,
        suspendedForMs: this.snapshot.suspendedForMs + suspendedForMs,
      };
    }
    return ok;
  }

  private assertProposed(): void {
    if (this.snapshot.status !== JointParticipantStatus.PROPOSED) {
      throw new JointDomainError('JNT_PART_NOT_PROPOSED', '仅拟参与状态可确认或撤回');
    }
  }

  private transition(
    machine: JointParticipantStateMachine,
    event: JointParticipantEvent,
    now: Date,
  ): boolean {
    const result = machine.transition({ event, currentState: this.snapshot.status });
    if (!result.allowed || result.nextState === undefined) {
      return false;
    }
    this.snapshot = {
      ...this.snapshot,
      status: result.nextState,
      revisionNumber: this.snapshot.revisionNumber + 1,
      updatedAt: now,
    };
    return true;
  }
}
