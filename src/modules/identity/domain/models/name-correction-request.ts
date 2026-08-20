/**
 * 姓名更正申请聚合根（IDN-016）。
 *
 * 承载：学生提交的姓名更正申请（可附证明引用）、超管裁决（批准/驳回）、
 * 批准后的 Casdoor 同步落点（写后定向读回收口）。姓名是只读权威字段，
 * 不进入本人白名单编辑与冲突选择（IDN-006/017）；唯一变更通道即本申请
 * 经超管批准（IDN-016）。
 *
 * 不变量：
 * - 同一主体同时最多一条待裁决（SUBMITTED）申请（重复提交拒绝）；
 * - 裁决只一次；终态不转换；
 * - 批准后显示新姓名并同步 Casdoor，本地审计保留旧姓名（IDN-016）；
 * - 同步以至少一次执行 + 幂等标记收口（ADR-004），迟到重放安全。
 */

import type { DomainEvent } from './domain-event';
import type { NameCorrectionStateMachine } from '../state-machines/name-correction.state-machine';
import { NameCorrectionEvent, NameCorrectionState } from '../state-machines/name-correction.state-machine';

export interface NameCorrectionRequestSnapshot {
  readonly id: string;
  readonly subjectId: string;
  /** 提交时的可信观测旧姓名（调用方经 Casdoor 读回取得，CAS-REC-001） */
  readonly oldName: string;
  readonly requestedName: string;
  /** 证明引用（可附证明；只存引用不存附件正文） */
  readonly proofReference: string | null;
  readonly status: NameCorrectionState;
  readonly decidedBy: string | null;
  readonly decidedAt: Date | null;
  readonly decisionReason: string | null;
  /** 批准后 Casdoor 写入已定向读回收口的时间（幂等标记） */
  readonly appliedAt: Date | null;
  readonly version: number;
  readonly createdAt: Date;
}

export type NameCorrectionDomainEvent = DomainEvent<
  'NAME_CORRECTION_SUBMITTED' | 'NAME_CORRECTION_DECIDED' | 'NAME_CORRECTION_APPLIED',
  {
    requestId: string;
    subjectId: string;
    fromState: NameCorrectionState;
    toState: NameCorrectionState;
  }
>;

export class NameCorrectionRequest {
  private readonly events_: NameCorrectionDomainEvent[] = [];

  private constructor(private snapshot: NameCorrectionRequestSnapshot) {}

  static fromSnapshot(snapshot: NameCorrectionRequestSnapshot): NameCorrectionRequest {
    return new NameCorrectionRequest(snapshot);
  }

  static create(input: {
    id: string;
    subjectId: string;
    oldName: string;
    requestedName: string;
    proofReference: string | null;
    now: Date;
  }): NameCorrectionRequest {
    const request = new NameCorrectionRequest({
      id: input.id,
      subjectId: input.subjectId,
      oldName: input.oldName,
      requestedName: input.requestedName,
      proofReference: input.proofReference,
      status: NameCorrectionState.SUBMITTED,
      decidedBy: null,
      decidedAt: null,
      decisionReason: null,
      appliedAt: null,
      version: 0,
      createdAt: input.now,
    });
    request.events_.push({
      type: 'NAME_CORRECTION_SUBMITTED',
      occurredAt: input.now,
      payload: {
        requestId: input.id,
        subjectId: input.subjectId,
        fromState: NameCorrectionState.SUBMITTED,
        toState: NameCorrectionState.SUBMITTED,
      },
    });
    return request;
  }

  get id(): string {
    return this.snapshot.id;
  }

  get subjectId(): string {
    return this.snapshot.subjectId;
  }

  get status(): NameCorrectionState {
    return this.snapshot.status;
  }

  get oldName(): string {
    return this.snapshot.oldName;
  }

  get requestedName(): string {
    return this.snapshot.requestedName;
  }

  get appliedAt(): Date | null {
    return this.snapshot.appliedAt;
  }

  get events(): readonly NameCorrectionDomainEvent[] {
    return this.events_;
  }

  toSnapshot(): NameCorrectionRequestSnapshot {
    return { ...this.snapshot };
  }

  /** 超管批准：推进至 APPROVED（裁决只一次由状态机保证） */
  approve(
    machine: NameCorrectionStateMachine,
    decidedBy: string,
    decisionReason: string,
    now: Date,
  ): boolean {
    return this.decide(machine, NameCorrectionEvent.APPROVE, decidedBy, decisionReason, now);
  }

  /** 超管驳回：推进至 REJECTED */
  reject(
    machine: NameCorrectionStateMachine,
    decidedBy: string,
    decisionReason: string,
    now: Date,
  ): boolean {
    return this.decide(machine, NameCorrectionEvent.REJECT, decidedBy, decisionReason, now);
  }

  /** Casdoor 写入定向读回收口（CAS-REC-001）：幂等标记，迟到重放安全 */
  markApplied(now: Date): void {
    if (this.snapshot.status !== NameCorrectionState.APPROVED || this.snapshot.appliedAt !== null) {
      return;
    }
    this.snapshot = { ...this.snapshot, appliedAt: now };
    this.events_.push({
      type: 'NAME_CORRECTION_APPLIED',
      occurredAt: now,
      payload: {
        requestId: this.snapshot.id,
        subjectId: this.snapshot.subjectId,
        fromState: NameCorrectionState.APPROVED,
        toState: NameCorrectionState.APPROVED,
      },
    });
  }

  private decide(
    machine: NameCorrectionStateMachine,
    event: NameCorrectionEvent,
    decidedBy: string,
    decisionReason: string,
    now: Date,
  ): boolean {
    const result = machine.transition({
      event,
      currentState: this.snapshot.status,
    });
    if (!result.allowed) {
      return false;
    }
    const fromState = this.snapshot.status;
    this.snapshot = {
      ...this.snapshot,
      status: result.nextState,
      decidedBy,
      decidedAt: now,
      decisionReason,
      version: this.snapshot.version + 1,
    };
    this.events_.push({
      type: 'NAME_CORRECTION_DECIDED',
      occurredAt: now,
      payload: {
        requestId: this.snapshot.id,
        subjectId: this.snapshot.subjectId,
        fromState,
        toState: result.nextState,
      },
    });
    return true;
  }
}