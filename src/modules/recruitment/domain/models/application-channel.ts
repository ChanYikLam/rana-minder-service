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
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export class ApplicationChannel {
  private constructor(private snapshot: ApplicationChannelSnapshot) {}

  static fromSnapshot(snapshot: ApplicationChannelSnapshot): ApplicationChannel {
    return new ApplicationChannel(snapshot);
  }

  static createClosed(input: {
    id: string;
    activityId: string;
    clubId: string;
    now: Date;
  }): ApplicationChannel {
    return new ApplicationChannel({
      id: input.id,
      activityId: input.activityId,
      clubId: input.clubId,
      status: ApplicationChannelStatus.CLOSED,
      openAt: null,
      closeAt: null,
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

  toSnapshot(): ApplicationChannelSnapshot {
    return { ...this.snapshot };
  }

  /** 当前是否接受新报名（仅 OPEN 态） */
  isAccepting(): boolean {
    return this.snapshot.status === ApplicationChannelStatus.OPEN;
  }

  open(machine: ApplicationChannelStateMachine, now: Date): boolean {
    const ok = this.transition(machine, ApplicationChannelEvent.OPEN, now);
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

  private transition(
    machine: ApplicationChannelStateMachine,
    event: ApplicationChannelEvent,
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
