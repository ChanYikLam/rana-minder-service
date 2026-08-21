/**
 * 面试记录聚合（recruitment 域；REC-005、REC-011/012/013/040/041）。
 *
 * 一份记录对应一个申请人 + 一轮次；预约/出勤变化由应用层编排并通知；面试官独立评价
 * 追加版本（轮次关闭前可改，关闭后仅事实纠错，由应用层控制）。作废保留原始事实。
 */

import {
  InterviewRecordStatus,
  InterviewRecordStateMachine,
  InterviewRecordEvent,
  DefaultInterviewRecordStateMachine,
} from '../state-machines/interview-record.state-machine';

export interface InterviewEvaluation {
  readonly interviewerId: string;
  readonly values: Record<string, unknown>;
  readonly decidedAt: Date;
}

export interface InterviewRecordSnapshot {
  readonly id: string;
  readonly applicationId: string;
  readonly activityId: string;
  readonly clubId: string;
  readonly roundId: string;
  readonly applicantId: string;
  readonly status: InterviewRecordStatus;
  readonly interviewerId: string | null;
  readonly scheduledAt: Date | null;
  readonly location: string | null;
  readonly skipReason: string | null;
  readonly holdUntil: Date | null;
  readonly evaluations: readonly InterviewEvaluation[];
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export class InterviewRecord {
  private constructor(private snapshot: InterviewRecordSnapshot) {}

  static fromSnapshot(snapshot: InterviewRecordSnapshot): InterviewRecord {
    return new InterviewRecord(snapshot);
  }

  static createPending(input: {
    id: string;
    applicationId: string;
    activityId: string;
    clubId: string;
    roundId: string;
    applicantId: string;
    now: Date;
  }): InterviewRecord {
    return new InterviewRecord({
      id: input.id,
      applicationId: input.applicationId,
      activityId: input.activityId,
      clubId: input.clubId,
      roundId: input.roundId,
      applicantId: input.applicantId,
      status: InterviewRecordStatus.PENDING_SELECTION,
      interviewerId: null,
      scheduledAt: null,
      location: null,
      skipReason: null,
      holdUntil: null,
      evaluations: [],
      createdAt: input.now,
      updatedAt: input.now,
    });
  }

  get id(): string {
    return this.snapshot.id;
  }
  get status(): InterviewRecordStatus {
    return this.snapshot.status;
  }
  get roundId(): string {
    return this.snapshot.roundId;
  }

  toSnapshot(): InterviewRecordSnapshot {
    return { ...this.snapshot };
  }

  schedule(
    machine: InterviewRecordStateMachine,
    interviewerId: string,
    scheduledAt: Date,
    location: string | null,
    now: Date,
  ): boolean {
    if (!this.transition(machine, InterviewRecordEvent.SCHEDULE, now)) {
      return false;
    }
    this.snapshot = {
      ...this.snapshot,
      interviewerId,
      scheduledAt,
      location,
      updatedAt: now,
    };
    return true;
  }

  /** 作废后重排到 SCHEDULED 时重新分配面试官/时间/地点（不切换状态） */
  reassign(interviewerId: string, scheduledAt: Date, location: string | null, now: Date): void {
    if (this.snapshot.status !== InterviewRecordStatus.SCHEDULED) {
      throw new Error('仅已重排至 SCHEDULED 的面试记录可重新分配');
    }
    this.snapshot = {
      ...this.snapshot,
      interviewerId,
      scheduledAt,
      location,
      updatedAt: now,
    };
  }

  start(machine: InterviewRecordStateMachine, now: Date): boolean {
    return this.transition(machine, InterviewRecordEvent.START, now);
  }

  complete(machine: InterviewRecordStateMachine, now: Date): boolean {
    return this.transition(machine, InterviewRecordEvent.COMPLETE, now);
  }

  void(machine: InterviewRecordStateMachine, now: Date): boolean {
    return this.transition(machine, InterviewRecordEvent.VOID, now);
  }

  cancel(machine: InterviewRecordStateMachine, now: Date): boolean {
    return this.transition(machine, InterviewRecordEvent.CANCEL, now);
  }

  reschedule(machine: InterviewRecordStateMachine, now: Date): boolean {
    return this.transition(machine, InterviewRecordEvent.RESCHEDULE, now);
  }

  /** 跳轮/免试：须填原因审计，不伪造已完成记录（REC-040） */
  skip(machine: InterviewRecordStateMachine, reason: string, now: Date): boolean {
    if (!this.transition(machine, InterviewRecordEvent.SKIP, now)) {
      return false;
    }
    this.snapshot = { ...this.snapshot, skipReason: reason, updatedAt: now };
    return true;
  }

  /** 暂缓：须设处理期限（不晚于活动结束，REC-041） */
  hold(machine: InterviewRecordStateMachine, until: Date, now: Date): boolean {
    if (!this.transition(machine, InterviewRecordEvent.HOLD, now)) {
      return false;
    }
    this.snapshot = { ...this.snapshot, holdUntil: until, updatedAt: now };
    return true;
  }

  resume(now: Date): boolean {
    return this.transition(
      new DefaultInterviewRecordStateMachine(),
      InterviewRecordEvent.RESUME,
      now,
    );
  }

  /** 记录面试官评价（轮次关闭前；应用层鉴权并控制可见性） */
  recordEvaluation(interviewerId: string, values: Record<string, unknown>, now: Date): void {
    if (
      this.snapshot.status !== InterviewRecordStatus.IN_PROGRESS &&
      this.snapshot.status !== InterviewRecordStatus.COMPLETED
    ) {
      throw new Error('仅进行中或已完成面试可记录评价');
    }
    const evaluation: InterviewEvaluation = { interviewerId, values, decidedAt: now };
    this.snapshot = {
      ...this.snapshot,
      evaluations: [...this.snapshot.evaluations, evaluation],
      updatedAt: now,
    };
  }

  private transition(
    machine: InterviewRecordStateMachine,
    event: InterviewRecordEvent,
    now: Date,
  ): boolean {
    const result = machine.transition({ event, currentState: this.snapshot.status });
    if (!result.allowed) {
      return false;
    }
    this.snapshot = { ...this.snapshot, status: result.nextState, updatedAt: now };
    return true;
  }
}
