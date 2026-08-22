/**
 * 联合活动聚合（JNT-001）。普通面试与联合面试完全独立，本聚合不持有人/部门结论细节。
 *
 * 不变量见 joint-activity.state-machine.ts。领域层提供：
 * - assertNotTerminal()：终态拒绝普通业务写命令
 * - markFirstInvitation()：并发首邀单胜者（乐观锁由仓储层保证，此处仅业务门控）
 * - recordConfirmRound()：名单变化时递增轮次，使旧确认失效
 */

import {
  JointActivityStatus,
  JointActivityStateMachine,
  JointActivityEvent,
} from '../state-machines/joint-activity.state-machine';
import { JointDomainError } from '../errors';

export interface JointActivitySnapshot {
  readonly id: string;
  readonly title: string;
  readonly description: string | null;
  readonly status: JointActivityStatus;
  /** 当前确认轮次；名单每次变化 +1，确认须匹配此值 */
  readonly confirmRound: number;
  readonly confirmDeadline: Date | null;
  readonly publishedAt: Date | null;
  readonly firstInvitationAt: Date | null;
  readonly cancelRound: number;
  readonly forcedEndedReason: string | null;
  readonly revisionNumber: number;
  readonly createdBy: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export class JointActivity {
  private constructor(private snapshot: JointActivitySnapshot) {}

  static fromSnapshot(snapshot: JointActivitySnapshot): JointActivity {
    return new JointActivity(snapshot);
  }

  static createDraft(input: {
    id: string;
    title: string;
    description?: string | null;
    confirmDeadline: Date;
    createdBy: string;
    now: Date;
  }): JointActivity {
    return new JointActivity({
      id: input.id,
      title: input.title,
      description: input.description ?? null,
      status: JointActivityStatus.DRAFT_CONFIRMING,
      confirmRound: 1,
      confirmDeadline: input.confirmDeadline,
      publishedAt: null,
      firstInvitationAt: null,
      cancelRound: 0,
      forcedEndedReason: null,
      revisionNumber: 1,
      createdBy: input.createdBy,
      createdAt: input.now,
      updatedAt: input.now,
    });
  }

  get id(): string {
    return this.snapshot.id;
  }
  get status(): JointActivityStatus {
    return this.snapshot.status;
  }
  get confirmRound(): number {
    return this.snapshot.confirmRound;
  }
  get publishedAt(): Date | null {
    return this.snapshot.publishedAt;
  }
  get firstInvitationAt(): Date | null {
    return this.snapshot.firstInvitationAt;
  }

  toSnapshot(): JointActivitySnapshot {
    return { ...this.snapshot };
  }

  isTerminal(): boolean {
    return (
      this.snapshot.status === JointActivityStatus.ENDED ||
      this.snapshot.status === JointActivityStatus.CANCELLED ||
      this.snapshot.status === JointActivityStatus.FORCE_ENDED
    );
  }

  /** 终态只读：拒绝一切普通业务写命令（纠错审计/独立成员流程除外，由调用方区分） */
  assertNotTerminal(): void {
    if (this.isTerminal()) {
      throw new JointDomainError('JNT_ACT_TERMINAL', '联合活动已处于终态，拒绝普通业务写命令');
    }
  }

  /** 至少两个拟参与社团、须设确认期限才能成立（应用层在 confirmAll 前校验数量） */
  confirmAll(machine: JointActivityStateMachine, now: Date): boolean {
    this.assertNotTerminal();
    return this.transition(machine, JointActivityEvent.CONFIRM_ALL, now);
  }

  publish(machine: JointActivityStateMachine, now: Date): boolean {
    this.assertNotTerminal();
    const ok = this.transition(machine, JointActivityEvent.PUBLISH, now);
    if (ok) {
      this.snapshot = { ...this.snapshot, publishedAt: now };
    }
    return ok;
  }

  /** 首邀：并发只有一份成功（乐观锁由仓储保证此处幂等标记） */
  markFirstInvitation(machine: JointActivityStateMachine, now: Date): boolean {
    this.assertNotTerminal();
    if (this.snapshot.firstInvitationAt !== null) {
      return false;
    }
    const ok = this.transition(machine, JointActivityEvent.SEND_FIRST_INVITATION, now);
    if (ok) {
      this.snapshot = { ...this.snapshot, firstInvitationAt: now };
    }
    return ok;
  }

  cancelAll(machine: JointActivityStateMachine, now: Date): boolean {
    if (this.snapshot.firstInvitationAt !== null) {
      throw new JointDomainError('JNT_ACT_FIRST_INVITE_LOCK', '已存在首邀，禁止取消整个活动');
    }
    this.assertNotTerminal();
    const next = this.snapshot.cancelRound + 1;
    const ok = this.transition(machine, JointActivityEvent.CANCEL_ALL, now);
    if (ok) {
      this.snapshot = { ...this.snapshot, cancelRound: next };
    }
    return ok;
  }

  beginEndConfirm(machine: JointActivityStateMachine, now: Date): boolean {
    this.assertNotInherited();
    return this.transition(machine, JointActivityEvent.BEGIN_END_CONFIRM, now);
  }

  end(machine: JointActivityStateMachine, now: Date): boolean {
    this.assertNotInherited();
    return this.transition(machine, JointActivityEvent.END, now);
  }

  forceEnd(machine: JointActivityStateMachine, reason: string, now: Date): boolean {
    const ok = this.transition(machine, JointActivityEvent.FORCE_END, now);
    if (ok) {
      this.snapshot = { ...this.snapshot, forcedEndedReason: reason };
    }
    return ok;
  }

  /** 名单调整/重新发起：递增确认轮次，旧确认全部失效 */
  bumpConfirmRound(now: Date, nextDeadline: Date): void {
    this.assertNotTerminal();
    if (this.snapshot.firstInvitationAt !== null) {
      throw new JointDomainError('JNT_ACT_LOCKED', '已公布/首邀后名单不可调整');
    }
    this.snapshot = {
      ...this.snapshot,
      confirmRound: this.snapshot.confirmRound + 1,
      confirmDeadline: nextDeadline,
      updatedAt: now,
    };
  }

  private assertNotInherited(): void {
    if (this.snapshot.status === JointActivityStatus.FORCE_ENDED) {
      throw new JointDomainError('JNT_ACT_TERMINAL', '强制结束活动不可再变更');
    }
    if (this.isTerminal()) {
      throw new JointDomainError('JNT_ACT_TERMINAL', '联合活动已处于终态');
    }
  }

  private transition(
    machine: JointActivityStateMachine,
    event: JointActivityEvent,
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
