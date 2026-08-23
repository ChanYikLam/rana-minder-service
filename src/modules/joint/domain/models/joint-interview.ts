/**
 * 联合单次面试记录聚合（JNT-004）。一申请人一联合活动唯一面试，评价数组 append-only 保留完整修改史。
 *
 * 面试作废联动：作废后全部未接受结论与邀请进入待复核/冻结，由调用方经端口处理。
 */

import {
  JointInterviewStatus,
  JointInterviewStateMachine,
  JointInterviewEvent,
} from '../state-machines/joint-interview.state-machine';
import { JointDomainError } from '../errors';

export interface JointInterviewEvaluation {
  readonly clubId: string;
  readonly interviewerId: string;
  readonly values: Record<string, unknown>;
  readonly decidedAt: Date;
  /** 完整修改历史（append-only），活动结束前可多次修改 */
  readonly history: readonly {
    readonly values: Record<string, unknown>;
    readonly editorId: string;
    readonly at: Date;
  }[];
}

export interface JointInterviewSnapshot {
  readonly id: string;
  readonly jointActivityId: string;
  readonly jointApplicationId: string;
  readonly status: JointInterviewStatus;
  readonly scheduledAt: Date | null;
  readonly location: string | null;
  readonly method: string | null;
  readonly evaluations: readonly JointInterviewEvaluation[];
  readonly voidedReason: string | null;
  readonly revisionNumber: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export class JointInterview {
  private constructor(private snapshot: JointInterviewSnapshot) {}

  static fromSnapshot(snapshot: JointInterviewSnapshot): JointInterview {
    return new JointInterview(snapshot);
  }

  static createPending(input: {
    id: string;
    jointActivityId: string;
    jointApplicationId: string;
    now: Date;
  }): JointInterview {
    return new JointInterview({
      id: input.id,
      jointActivityId: input.jointActivityId,
      jointApplicationId: input.jointApplicationId,
      status: JointInterviewStatus.PENDING_CHOICE,
      scheduledAt: null,
      location: null,
      method: null,
      evaluations: [],
      voidedReason: null,
      revisionNumber: 1,
      createdAt: input.now,
      updatedAt: input.now,
    });
  }

  get id(): string {
    return this.snapshot.id;
  }
  get jointApplicationId(): string {
    return this.snapshot.jointApplicationId;
  }
  get status(): JointInterviewStatus {
    return this.snapshot.status;
  }
  get revisionNumber(): number {
    return this.snapshot.revisionNumber;
  }

  toSnapshot(): JointInterviewSnapshot {
    return { ...this.snapshot };
  }

  schedule(
    machine: JointInterviewStateMachine,
    input: {
      scheduledAt: Date;
      location: string;
      method: string;
      now: Date;
    },
  ): boolean {
    const ok = this.transition(machine, JointInterviewEvent.SCHEDULE, input.now);
    if (ok) {
      this.snapshot = {
        ...this.snapshot,
        scheduledAt: input.scheduledAt,
        location: input.location,
        method: input.method,
      };
    }
    return ok;
  }

  start(machine: JointInterviewStateMachine, now: Date): boolean {
    return this.transition(machine, JointInterviewEvent.START, now);
  }

  complete(machine: JointInterviewStateMachine, now: Date): boolean {
    return this.transition(machine, JointInterviewEvent.COMPLETE, now);
  }

  voidInterview(machine: JointInterviewStateMachine, reason: string, now: Date): boolean {
    const ok = this.transition(machine, JointInterviewEvent.VOID, now);
    if (ok) {
      this.snapshot = { ...this.snapshot, voidedReason: reason };
    }
    return ok;
  }

  reschedule(
    machine: JointInterviewStateMachine,
    input: { scheduledAt: Date; location: string; method: string; now: Date },
  ): boolean {
    const ok = this.transition(machine, JointInterviewEvent.RESCHEDULE, input.now);
    if (ok) {
      this.snapshot = {
        ...this.snapshot,
        scheduledAt: input.scheduledAt,
        location: input.location,
        method: input.method,
        voidedReason: null,
      };
    }
    return ok;
  }

  /** 追加/修改某社团评价，保留修改历史（活动结束前可反复调用） */
  addEvaluation(
    clubId: string,
    interviewerId: string,
    values: Record<string, unknown>,
    now: Date,
  ): void {
    if (this.snapshot.status === JointInterviewStatus.COMPLETED) {
      throw new JointDomainError('JNT_INT_LOCKED', '面试已完成，评价已锁定（仅纠错）');
    }
    const nextEvaluations = this.snapshot.evaluations.map((e) =>
      e.clubId === clubId
        ? {
            ...e,
            values,
            decidedAt: now,
            history: [...e.history, { values: e.values, editorId: interviewerId, at: now }],
          }
        : e,
    );
    const exists = this.snapshot.evaluations.some((e) => e.clubId === clubId);
    if (!exists) {
      nextEvaluations.push({
        clubId,
        interviewerId,
        values,
        decidedAt: now,
        history: [{ values, editorId: interviewerId, at: now }],
      });
    }
    this.snapshot = {
      ...this.snapshot,
      evaluations: nextEvaluations,
      revisionNumber: this.snapshot.revisionNumber + 1,
      updatedAt: now,
    };
  }

  private transition(
    machine: JointInterviewStateMachine,
    event: JointInterviewEvent,
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
