/**
 * 部门考察路径聚合（recruitment 域；REC-004、REC-018/019/020/023/039）。
 *
 * 正式志愿自动建立路径；调剂部门由负责人/人事"纳入本部门考察"建立（重复不建重复路径）；
 * 未勾选允许调剂时未填报部门不能建路径/看材料。部门内部决定由负责人/人事记录，
 * 保留全部版本；普通面试官无决定权（应用层鉴权）。部门 Group 异常暂停该路径。
 */

import {
  DepartmentPathStatus,
  DepartmentPathStateMachine,
  DepartmentDecision,
} from '../state-machines/department-path.state-machine';

export interface DepartmentDecisionRecord {
  readonly decision: DepartmentDecision;
  readonly decidedBy: string;
  readonly decidedAt: Date;
  readonly note: string | null;
}

export interface DepartmentPathSnapshot {
  readonly id: string;
  readonly applicationId: string;
  readonly activityId: string;
  readonly clubId: string;
  readonly departmentId: string;
  readonly status: DepartmentPathStatus;
  readonly allowTransfer: boolean;
  readonly decisions: readonly DepartmentDecisionRecord[];
  readonly previousStatusBeforeSuspend: DepartmentPathStatus | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly revisionNumber: number;
}

export class DepartmentPath {
  private constructor(private snapshot: DepartmentPathSnapshot) {}

  static fromSnapshot(snapshot: DepartmentPathSnapshot): DepartmentPath {
    return new DepartmentPath(snapshot);
  }

  static createFromChoice(input: {
    id: string;
    applicationId: string;
    activityId: string;
    clubId: string;
    departmentId: string;
    allowTransfer: boolean;
    now: Date;
  }): DepartmentPath {
    return new DepartmentPath({
      id: input.id,
      applicationId: input.applicationId,
      activityId: input.activityId,
      clubId: input.clubId,
      departmentId: input.departmentId,
      status: DepartmentPathStatus.PENDING,
      allowTransfer: input.allowTransfer,
      decisions: [],
      previousStatusBeforeSuspend: null,
      createdAt: input.now,
      updatedAt: input.now,
      revisionNumber: 0,
    });
  }

  get id(): string {
    return this.snapshot.id;
  }
  get status(): DepartmentPathStatus {
    return this.snapshot.status;
  }
  get allowTransfer(): boolean {
    return this.snapshot.allowTransfer;
  }
  get groupException(): boolean {
    return this.snapshot.status === DepartmentPathStatus.SUSPENDED;
  }

  toSnapshot(): DepartmentPathSnapshot {
    return { ...this.snapshot };
  }

  /** 记录部门内部决定（负责人/人事；应用层鉴权），追加版本 */
  recordDecision(
    machine: DepartmentPathStateMachine,
    decision: DepartmentDecision,
    decidedBy: string,
    now: Date,
    note: string | null = null,
  ): boolean {
    const result = machine.transitionOnDecision({ decision, currentState: this.snapshot.status });
    if (!result.allowed) {
      return false;
    }
    const record: DepartmentDecisionRecord = { decision, decidedBy, decidedAt: now, note };
    this.snapshot = {
      ...this.snapshot,
      status: result.nextState,
      decisions: [...this.snapshot.decisions, record],
      updatedAt: now,
      revisionNumber: this.snapshot.revisionNumber + 1,
    };
    return true;
  }

  /** 部门 Group 异常：暂停该路径（记录恢复态） */
  suspend(machine: DepartmentPathStateMachine, now: Date): boolean {
    const result = machine.transitionOnSuspend({ currentState: this.snapshot.status });
    if (!result.allowed) {
      return false;
    }
    this.snapshot = {
      ...this.snapshot,
      previousStatusBeforeSuspend: this.snapshot.status,
      status: result.nextState,
      updatedAt: now,
      revisionNumber: this.snapshot.revisionNumber + 1,
    };
    return true;
  }

  /** 恢复部门 Group 异常：经状态机恢复原主状态（SRS-SM-REC-004） */
  restore(machine: DepartmentPathStateMachine, now: Date): boolean {
    const result = machine.transitionOnRestore({
      currentState: this.snapshot.status,
      previousStatus: this.snapshot.previousStatusBeforeSuspend ?? DepartmentPathStatus.PENDING,
    });
    if (!result.allowed) {
      return false;
    }
    this.snapshot = {
      ...this.snapshot,
      status: result.nextState,
      previousStatusBeforeSuspend: null,
      updatedAt: now,
      revisionNumber: this.snapshot.revisionNumber + 1,
    };
    return true;
  }
}
