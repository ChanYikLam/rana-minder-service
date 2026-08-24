/**
 * 补救窗口聚合（recruitment 域；REC-003、REC-006/009/038、REC-044）。
 *
 * 记录一次为受影响申请开启的补救窗口（规则收紧补窗 / 个人恢复 / 身份异常顺延）。
 * 开窗即不可变事件记录：窗口有效性（截止晚于当前、目标申请归属活动）由命令层
 * 守卫，创建后落库供审计与追踪（弥补此前"瞬时副作用、windowId 未持久化"缺口）。
 */

import type { RemedyWindowKind } from '../../application/commands/remedy-window.use-case';

export interface RemedyWindowSnapshot {
  readonly windowId: string;
  readonly activityId: string;
  readonly kind: RemedyWindowKind;
  readonly targetApplicationIds: readonly string[];
  readonly deadline: Date;
  readonly reason: string;
  readonly createdBy: string;
  readonly createdAt: Date;
}

export class RemedyWindow {
  private constructor(private readonly snapshot: RemedyWindowSnapshot) {}

  static create(input: {
    windowId: string;
    activityId: string;
    kind: RemedyWindowKind;
    targetApplicationIds: readonly string[];
    deadline: Date;
    reason: string;
    createdBy: string;
    createdAt: Date;
  }): RemedyWindow {
    return new RemedyWindow({
      windowId: input.windowId,
      activityId: input.activityId,
      kind: input.kind,
      targetApplicationIds: input.targetApplicationIds,
      deadline: input.deadline,
      reason: input.reason,
      createdBy: input.createdBy,
      createdAt: input.createdAt,
    });
  }

  static fromSnapshot(snapshot: RemedyWindowSnapshot): RemedyWindow {
    return new RemedyWindow(snapshot);
  }

  get windowId(): string {
    return this.snapshot.windowId;
  }
  get activityId(): string {
    return this.snapshot.activityId;
  }
  get kind(): RemedyWindowKind {
    return this.snapshot.kind;
  }
  get targetApplicationIds(): readonly string[] {
    return this.snapshot.targetApplicationIds;
  }
  get deadline(): Date {
    return this.snapshot.deadline;
  }
  get reason(): string {
    return this.snapshot.reason;
  }
  get createdBy(): string {
    return this.snapshot.createdBy;
  }
  get createdAt(): Date {
    return this.snapshot.createdAt;
  }

  toSnapshot(): RemedyWindowSnapshot {
    return { ...this.snapshot };
  }
}
