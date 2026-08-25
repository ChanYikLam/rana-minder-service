/**
 * 报名通道聚合（recruitment 域；REC-002、SRS-SM-REC-002）。
 *
 * 通道属于某活动与社团；开放后仍可增加部门/放宽资格/延长截止（须通知受影响
 * 人员），关闭后可重开新窗口。暂停仅停新报名与申请人修改。
 */

import {
  ApplicationChannelStatus,
  ApplicationChannelStateMachine,
  ApplicationChannelEvent,
} from '../state-machines/application-channel.state-machine';

export interface ApplicationChannelSnapshot {
  readonly id: string;
  readonly activityId: string;
  readonly clubId: string;
  readonly status: ApplicationChannelStatus;
  readonly openAt: Date | null;
  readonly closeAt: Date | null;
  /** 当前窗口报名截止（重开新窗口时设置；首次开放为 null，截止由活动层控制） */
  readonly deadline: Date | null;
  readonly minChoices: number;
  readonly maxChoices: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export class ApplicationChannel {
  private constructor(private snapshot: ApplicationChannelSnapshot) {}

  static fromSnapshot(snapshot: ApplicationChannelSnapshot): ApplicationChannel {
    return new ApplicationChannel(snapshot);
  }

  static createNotStarted(input: {
    id: string;
    activityId: string;
    clubId: string;
    minChoices?: number;
    maxChoices?: number;
    now: Date;
  }): ApplicationChannel {
    return new ApplicationChannel({
      id: input.id,
      activityId: input.activityId,
      clubId: input.clubId,
      status: ApplicationChannelStatus.NOT_STARTED,
      openAt: null,
      closeAt: null,
      deadline: null,
      minChoices: input.minChoices ?? 1,
      maxChoices: input.maxChoices ?? 1,
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
  get status(): ApplicationChannelStatus {
    return this.snapshot.status;
  }
  get closeAt(): Date | null {
    return this.snapshot.closeAt;
  }
  get minChoices(): number {
    return this.snapshot.minChoices;
  }
  get maxChoices(): number {
    return this.snapshot.maxChoices;
  }

  toSnapshot(): ApplicationChannelSnapshot {
    return { ...this.snapshot };
  }

  /** 当前是否接受新报名（仅 OPEN 态） */
  isAccepting(): boolean {
    return this.snapshot.status === ApplicationChannelStatus.OPEN;
  }

  open(
    machine: ApplicationChannelStateMachine,
    now: Date,
    guard?: { readonly newDeadlineStrictlyAfterNow?: boolean },
  ): boolean {
    const ok = this.transition(machine, ApplicationChannelEvent.OPEN, now, guard);
    if (ok && this.snapshot.openAt === null) {
      this.snapshot = { ...this.snapshot, openAt: now };
    }
    return ok;
  }

  pause(now: Date): void {
    if (this.snapshot.status !== ApplicationChannelStatus.OPEN) {
      throw new Error('仅开放中的报名通道可暂停');
    }
    this.snapshot = { ...this.snapshot, status: ApplicationChannelStatus.PAUSED, updatedAt: now };
  }

  resume(now: Date): void {
    if (this.snapshot.status !== ApplicationChannelStatus.PAUSED) {
      throw new Error('报名通道未在暂停状态');
    }
    this.snapshot = { ...this.snapshot, status: ApplicationChannelStatus.OPEN, updatedAt: now };
  }

  close(machine: ApplicationChannelStateMachine, now: Date): boolean {
    const ok = this.transition(machine, ApplicationChannelEvent.CLOSE, now);
    if (ok) {
      this.snapshot = { ...this.snapshot, closeAt: now };
    }
    return ok;
  }

  /**
   * 重开新窗口（SRS-SM-REC-002）：CLOSED → OPEN，须携新截止且严格晚于当前；
   * 新截止持久化到 deadline（报名用例按窗口截止校验）。
   */
  reopen(machine: ApplicationChannelStateMachine, newDeadline: Date, now: Date): boolean {
    // 防御纵深：截止守卫收口到聚合（SRS-SM-REC-002 拒绝条件
    // 「新截止缺失/越界/不晚于重开时刻」）。状态机仅校验 CLOSED→OPEN 必须携带
    // 重开标志，此处直接校验新截止严格晚于重开时刻，杜绝调用方绕过命令层校验。
    if (newDeadline.getTime() <= now.getTime()) {
      return false;
    }
    if (
      !this.transition(machine, ApplicationChannelEvent.OPEN, now, {
        newDeadlineStrictlyAfterNow: true,
      })
    ) {
      return false;
    }
    this.snapshot = { ...this.snapshot, deadline: newDeadline, updatedAt: now };
    return true;
  }

  private transition(
    machine: ApplicationChannelStateMachine,
    event: ApplicationChannelEvent,
    now: Date,
    guard?: { readonly newDeadlineStrictlyAfterNow?: boolean },
  ): boolean {
    const result = machine.transition({
      event,
      currentState: this.snapshot.status,
      ...guard,
    });
    if (!result.allowed) {
      return false;
    }
    this.snapshot = { ...this.snapshot, status: result.nextState, updatedAt: now };
    return true;
  }
}
