/**
 * 联合报名通道聚合（JNT-006）。独立四态，每个联合活动唯一通道。不并入主状态、不复用普通报名通道。
 *
 * 暂停废止旧截止窗口；恢复须设新截止并创建新窗口；EXTEND 仅延长当前窗口；CLOSE 自动关闭；非终态可 REOPEN 新窗口。
 */

import {
  JointChannelStatus,
  JointChannelStateMachine,
  JointChannelEvent,
} from '../state-machines/joint-channel.state-machine';

export interface JointChannelWindow {
  readonly windowId: string;
  readonly openedAt: Date;
  readonly closedAt: Date | null;
  readonly deadline: Date;
  readonly version: number;
}

export interface JointChannelSnapshot {
  readonly id: string;
  readonly jointActivityId: string;
  readonly status: JointChannelStatus;
  readonly currentWindow: JointChannelWindow | null;
  readonly windows: readonly JointChannelWindow[];
  readonly revisionNumber: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export class JointChannel {
  private constructor(private snapshot: JointChannelSnapshot) {}

  static fromSnapshot(snapshot: JointChannelSnapshot): JointChannel {
    return new JointChannel(snapshot);
  }

  static channelId(jointActivityId: string): string {
    return `channel:${jointActivityId}`;
  }

  static createClosed(input: { jointActivityId: string; now: Date }): JointChannel {
    return new JointChannel({
      id: JointChannel.channelId(input.jointActivityId),
      jointActivityId: input.jointActivityId,
      status: JointChannelStatus.NOT_OPEN,
      currentWindow: null,
      windows: [],
      revisionNumber: 1,
      createdAt: input.now,
      updatedAt: input.now,
    });
  }

  get id(): string {
    return this.snapshot.id;
  }
  get jointActivityId(): string {
    return this.snapshot.jointActivityId;
  }
  get status(): JointChannelStatus {
    return this.snapshot.status;
  }
  get currentWindow(): JointChannelWindow | null {
    return this.snapshot.currentWindow;
  }
  get revisionNumber(): number {
    return this.snapshot.revisionNumber;
  }

  toSnapshot(): JointChannelSnapshot {
    return { ...this.snapshot };
  }

  isOpen(now: Date): boolean {
    return (
      this.snapshot.status === JointChannelStatus.OPEN &&
      this.snapshot.currentWindow !== null &&
      this.snapshot.currentWindow.closedAt === null &&
      this.snapshot.currentWindow.deadline.getTime() > now.getTime()
    );
  }

  open(
    machine: JointChannelStateMachine,
    input: {
      windowId: string;
      deadline: Date;
      now: Date;
    },
  ): boolean {
    const ok = this.transition(machine, JointChannelEvent.OPEN, input.now);
    if (ok) {
      this.snapshot = {
        ...this.snapshot,
        currentWindow: {
          windowId: input.windowId,
          openedAt: input.now,
          closedAt: null,
          deadline: input.deadline,
          version: 1,
        },
        windows: [
          ...this.snapshot.windows,
          {
            windowId: input.windowId,
            openedAt: input.now,
            closedAt: null,
            deadline: input.deadline,
            version: 1,
          },
        ],
      };
    }
    return ok;
  }

  suspend(machine: JointChannelStateMachine, now: Date): boolean {
    const ok = this.transition(machine, JointChannelEvent.SUSPEND, now);
    if (ok && this.snapshot.currentWindow) {
      this.snapshot = {
        ...this.snapshot,
        currentWindow: { ...this.snapshot.currentWindow, closedAt: now },
        windows: this.snapshot.windows.map((w) =>
          w.windowId === this.snapshot.currentWindow?.windowId ? { ...w, closedAt: now } : w,
        ),
      };
    }
    return ok;
  }

  /** 恢复：必须设新截止并创建新窗口 */
  resume(
    machine: JointChannelStateMachine,
    input: {
      windowId: string;
      deadline: Date;
      now: Date;
    },
  ): boolean {
    const ok = this.transition(machine, JointChannelEvent.RESUME, input.now);
    if (ok) {
      this.snapshot = {
        ...this.snapshot,
        currentWindow: {
          windowId: input.windowId,
          openedAt: input.now,
          closedAt: null,
          deadline: input.deadline,
          version: this.snapshot.windows.length + 1,
        },
        windows: [
          ...this.snapshot.windows,
          {
            windowId: input.windowId,
            openedAt: input.now,
            closedAt: null,
            deadline: input.deadline,
            version: this.snapshot.windows.length + 1,
          },
        ],
      };
    }
    return ok;
  }

  /** 仅延长当前窗口截止 */
  extend(machine: JointChannelStateMachine, input: { deadline: Date; now: Date }): boolean {
    const ok = this.transition(machine, JointChannelEvent.EXTEND, input.now);
    if (ok && this.snapshot.currentWindow) {
      const nextWindow = { ...this.snapshot.currentWindow, deadline: input.deadline };
      this.snapshot = {
        ...this.snapshot,
        currentWindow: nextWindow,
        windows: this.snapshot.windows.map((w) =>
          w.windowId === this.snapshot.currentWindow?.windowId ? nextWindow : w,
        ),
      };
    }
    return ok;
  }

  close(machine: JointChannelStateMachine, now: Date): boolean {
    const ok = this.transition(machine, JointChannelEvent.CLOSE, now);
    if (ok && this.snapshot.currentWindow) {
      this.snapshot = {
        ...this.snapshot,
        currentWindow: { ...this.snapshot.currentWindow, closedAt: now },
        windows: this.snapshot.windows.map((w) =>
          w.windowId === this.snapshot.currentWindow?.windowId ? { ...w, closedAt: now } : w,
        ),
      };
    }
    return ok;
  }

  /** 非终态活动可重开新窗口 */
  reopen(
    machine: JointChannelStateMachine,
    input: {
      windowId: string;
      deadline: Date;
      now: Date;
    },
  ): boolean {
    const ok = this.transition(machine, JointChannelEvent.REOPEN, input.now);
    if (ok) {
      this.snapshot = {
        ...this.snapshot,
        currentWindow: {
          windowId: input.windowId,
          openedAt: input.now,
          closedAt: null,
          deadline: input.deadline,
          version: this.snapshot.windows.length + 1,
        },
        windows: [
          ...this.snapshot.windows,
          {
            windowId: input.windowId,
            openedAt: input.now,
            closedAt: null,
            deadline: input.deadline,
            version: this.snapshot.windows.length + 1,
          },
        ],
      };
    }
    return ok;
  }

  private transition(
    machine: JointChannelStateMachine,
    event: JointChannelEvent,
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
