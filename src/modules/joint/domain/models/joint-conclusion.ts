/**
 * 参与社团结论聚合（JNT-005）。每个社团对每个联合申请人一份结论，可编辑→邀请→接受锁定。
 *
 * 不变量：关联邀请被接受后该社团结论立即锁定，不可再改为不录取；终态归档锁定保留全部版本。
 */

import {
  JointConclusionStatus,
  JointConclusionStateMachine,
  JointConclusionEvent,
  JointConclusionDecision,
} from '../state-machines/joint-conclusion.state-machine';
import { JointDomainError } from '../errors';

export interface JointConclusionVersion {
  readonly decision: JointConclusionDecision;
  readonly note: string | null;
  readonly editorId: string;
  readonly at: Date;
}

export interface JointConclusionSnapshot {
  readonly id: string;
  readonly jointActivityId: string;
  readonly jointApplicationId: string;
  readonly clubId: string;
  readonly status: JointConclusionStatus;
  readonly decision: JointConclusionDecision | null;
  readonly note: string | null;
  readonly version: number;
  readonly decidedBy: string | null;
  readonly decidedAt: Date | null;
  /** 关联邀请（INV-001 扩展）状态；ACCEPTED 触发本结论锁定 */
  readonly inviteStatus: 'NONE' | 'PENDING' | 'ACCEPTED' | 'REJECTED';
  /** 关联邀请 ID（INV-001 扩展）；接受/拒绝/恢复均据此回写 */
  readonly invitationId: string | null;
  readonly versions: readonly JointConclusionVersion[];
  readonly revisionNumber: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export class JointConclusion {
  private constructor(private snapshot: JointConclusionSnapshot) {}

  static fromSnapshot(snapshot: JointConclusionSnapshot): JointConclusion {
    return new JointConclusion(snapshot);
  }

  static conclusionId(jointApplicationId: string, clubId: string): string {
    return `conclusion:${jointApplicationId}:${clubId}`;
  }

  static createEditable(input: {
    jointActivityId: string;
    jointApplicationId: string;
    clubId: string;
    now: Date;
  }): JointConclusion {
    return new JointConclusion({
      id: JointConclusion.conclusionId(input.jointApplicationId, input.clubId),
      jointActivityId: input.jointActivityId,
      jointApplicationId: input.jointApplicationId,
      clubId: input.clubId,
      status: JointConclusionStatus.EDITABLE,
      decision: null,
      note: null,
      version: 1,
      decidedBy: null,
      decidedAt: null,
      inviteStatus: 'NONE',
      invitationId: null,
      versions: [],
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
  get clubId(): string {
    return this.snapshot.clubId;
  }
  get status(): JointConclusionStatus {
    return this.snapshot.status;
  }
  get decision(): JointConclusionDecision | null {
    return this.snapshot.decision;
  }
  get inviteStatus(): JointConclusionSnapshot['inviteStatus'] {
    return this.snapshot.inviteStatus;
  }
  get revisionNumber(): number {
    return this.snapshot.revisionNumber;
  }

  toSnapshot(): JointConclusionSnapshot {
    return { ...this.snapshot };
  }

  /** 编辑结论：仅可编辑态；接受锁定后禁止改写（纠错须另走审计） */
  edit(
    machine: JointConclusionStateMachine,
    input: {
      decision: JointConclusionDecision;
      note?: string | null;
      editorId: string;
      now: Date;
    },
  ): boolean {
    if (
      this.snapshot.status !== JointConclusionStatus.EDITABLE &&
      this.snapshot.status !== JointConclusionStatus.REVIEW_PENDING
    ) {
      throw new JointDomainError('JNT_CON_LOCKED', '结论已锁定或不可编辑，禁止改写');
    }
    const nextVersion = this.snapshot.version + 1;
    this.snapshot = {
      ...this.snapshot,
      // 编辑不改变所处阶段：处于待复核（REVIEW_PENDING）时编辑仍保留待复核标记，
      // 避免借编辑绕过复核流程；处于可编辑（EDITABLE）时保持不变。
      status: this.snapshot.status,
      decision: input.decision,
      note: input.note ?? null,
      version: nextVersion,
      decidedBy: input.editorId,
      decidedAt: input.now,
      versions: [
        ...this.snapshot.versions,
        {
          decision: input.decision,
          note: input.note ?? null,
          editorId: input.editorId,
          at: input.now,
        },
      ],
      revisionNumber: this.snapshot.revisionNumber + 1,
      updatedAt: input.now,
    };
    return true;
  }

  sendInvite(
    machine: JointConclusionStateMachine,
    input: { invitationId: string; now: Date },
  ): boolean {
    if (this.snapshot.decision == null) {
      throw new JointDomainError('JNT_CON_NO_DECISION', '未填写结论前禁止发送邀请');
    }
    if (this.snapshot.status === JointConclusionStatus.LOCKED_ACCEPTED) {
      throw new JointDomainError('JNT_CON_LOCKED', '已接受锁定的结论不可再发邀请');
    }
    const ok = this.transition(machine, JointConclusionEvent.SEND_INVITE, input.now);
    if (ok) {
      this.snapshot = {
        ...this.snapshot,
        inviteStatus: 'PENDING',
        invitationId: input.invitationId,
      };
    }
    return ok;
  }

  /** 邀请被接受：立即锁定该社团结论 */
  markInviteAccepted(machine: JointConclusionStateMachine, now: Date): boolean {
    const ok = this.transition(machine, JointConclusionEvent.ACCEPT_INVITE, now);
    if (ok) {
      this.snapshot = { ...this.snapshot, inviteStatus: 'ACCEPTED' };
    }
    return ok;
  }

  /** 邀请被拒绝：回退到可编辑+待复核，立即可重新编辑/重邀（避免卡死） */
  markInviteRejected(machine: JointConclusionStateMachine, now: Date): boolean {
    if (this.snapshot.inviteStatus === 'ACCEPTED') {
      throw new JointDomainError('JNT_CON_LOCKED', '已接受锁定的结论不可被拒绝');
    }
    const ok = this.transition(machine, JointConclusionEvent.REJECT_INVITE, now);
    if (ok) {
      this.snapshot = { ...this.snapshot, inviteStatus: 'REJECTED' };
    }
    return ok;
  }

  clearInvitation(_now: Date): void {
    this.snapshot = { ...this.snapshot, inviteStatus: 'NONE', invitationId: null };
  }

  /** 关联面试作废且未接受：进入可编辑＋待复核 */
  toReview(machine: JointConclusionStateMachine, now: Date): boolean {
    if (this.snapshot.inviteStatus === 'ACCEPTED') {
      throw new JointDomainError('JNT_CON_LOCKED', '已锁定结论不受面试作废影响');
    }
    return this.transition(machine, JointConclusionEvent.TO_REVIEW, now);
  }

  /** 邀请超时：未接受的邀请回退到可编辑＋待复核（保留 invitationId 以便沿用原冻结剩余时长） */
  timeoutInvite(machine: JointConclusionStateMachine, now: Date): boolean {
    if (this.snapshot.inviteStatus === 'ACCEPTED') {
      throw new JointDomainError('JNT_CON_LOCKED', '已接受锁定的结论不可超时回退');
    }
    const ok = this.transition(machine, JointConclusionEvent.TIMEOUT_INVITE, now);
    if (ok) {
      this.snapshot = { ...this.snapshot, inviteStatus: 'NONE' };
    }
    return ok;
  }

  /** 待复核后恢复邀请（沿用原冻结剩余时长，由端口层处理） */
  restoreFromReview(machine: JointConclusionStateMachine, now: Date): boolean {
    return this.transition(machine, JointConclusionEvent.RESTORE_FROM_REVIEW, now);
  }

  archive(machine: JointConclusionStateMachine, now: Date): boolean {
    return this.transition(machine, JointConclusionEvent.ARCHIVE, now);
  }

  /** 是否禁止改为不录取（已接受锁定） */
  isLockedAgainstReject(): boolean {
    return this.snapshot.inviteStatus === 'ACCEPTED';
  }

  private transition(
    machine: JointConclusionStateMachine,
    event: JointConclusionEvent,
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
