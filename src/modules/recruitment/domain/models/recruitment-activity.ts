/**
 * 招新活动聚合（recruitment 域；REC-001、SRS-SM-REC-001）。
 *
 * 一份活动归属一个社团（clubId）；负责人/人事可建、配、发、暂停、结束、取消；
 * 部门负责人无轮次/批次管理权；超管仅异常/违规处置（REC-001/003）。
 * 不变量：停等正交标志不影响主阶段状态；终态不可再转换。
 */

import {
  RecruitmentActivityStatus,
  RecruitmentActivityStateMachine,
  RecruitmentActivityEvent,
} from '../state-machines/recruitment-activity.state-machine';

export interface RecruitmentActivitySnapshot {
  readonly id: string;
  readonly clubId: string;
  readonly title: string;
  readonly description: string | null;
  readonly status: RecruitmentActivityStatus;
  readonly paused: boolean;
  readonly endDate: Date | null;
  readonly createdBy: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export class RecruitmentActivity {
  private constructor(private snapshot: RecruitmentActivitySnapshot) {}

  static fromSnapshot(snapshot: RecruitmentActivitySnapshot): RecruitmentActivity {
    return new RecruitmentActivity(snapshot);
  }

  static createDraft(input: {
    id: string;
    clubId: string;
    title: string;
    description: string | null;
    createdBy: string;
    endDate?: Date | null;
    now: Date;
  }): RecruitmentActivity {
    return new RecruitmentActivity({
      id: input.id,
      clubId: input.clubId,
      title: input.title,
      description: input.description,
      status: RecruitmentActivityStatus.DRAFT,
      paused: false,
      endDate: input.endDate ?? null,
      createdBy: input.createdBy,
      createdAt: input.now,
      updatedAt: input.now,
    });
  }

  get id(): string {
    return this.snapshot.id;
  }
  get clubId(): string {
    return this.snapshot.clubId;
  }
  get status(): RecruitmentActivityStatus {
    return this.snapshot.status;
  }
  get paused(): boolean {
    return this.snapshot.paused;
  }

  toSnapshot(): RecruitmentActivitySnapshot {
    return { ...this.snapshot };
  }

  open(machine: RecruitmentActivityStateMachine, now: Date): boolean {
    return this.transition(machine, RecruitmentActivityEvent.PUBLISH, now);
  }

  complete(machine: RecruitmentActivityStateMachine, now: Date): boolean {
    return this.transition(machine, RecruitmentActivityEvent.COMPLETE, now);
  }

  cancel(machine: RecruitmentActivityStateMachine, now: Date): boolean {
    return this.transition(machine, RecruitmentActivityEvent.CANCEL, now);
  }

  /** 暂停：仅进行中活动可暂停（正交标志，冻结业务与截止） */
  pause(now: Date): void {
    if (this.snapshot.status !== RecruitmentActivityStatus.OPEN) {
      throw new Error('仅进行中招新活动可暂停');
    }
    this.snapshot = { ...this.snapshot, paused: true, updatedAt: now };
  }

  /** 恢复：解除暂停标志（顺延逻辑由应用层依据暂停时长计算） */
  resume(now: Date): void {
    if (!this.snapshot.paused) {
      throw new Error('招新活动未在暂停状态');
    }
    this.snapshot = { ...this.snapshot, paused: false, updatedAt: now };
  }

  private transition(
    machine: RecruitmentActivityStateMachine,
    event: RecruitmentActivityEvent,
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
