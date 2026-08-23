/**
 * 联合申请聚合（JNT-003）。独立强类型对象，不推进普通招新申请或社团结论。
 *
 * 提交硬前提：consentSnapshotHash 必须等于活动公布时锁定的参与社团集合哈希。
 */

import {
  JointApplicationStatus,
  JointApplicationStateMachine,
  JointApplicationEvent,
} from '../state-machines/joint-application.state-machine';
import { JointDomainError } from '../errors';

export interface JointApplicationFormRef {
  readonly formId: string;
  readonly submissionId: string;
  readonly versionNumber: number;
}

export interface JointApplicationSnapshot {
  readonly id: string;
  readonly jointActivityId: string;
  readonly applicantId: string;
  readonly status: JointApplicationStatus;
  readonly formRef: JointApplicationFormRef | null;
  /** 提交时锁定的参与社团快照（clubId 列表） */
  readonly participantsSnapshot: readonly string[];
  /** 共享同意快照哈希，须与活动公布锁定集合哈希一致 */
  readonly consentSnapshotHash: string | null;
  readonly sharedNote: string | null;
  readonly revisionNumber: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export class JointApplication {
  private constructor(private snapshot: JointApplicationSnapshot) {}

  static fromSnapshot(snapshot: JointApplicationSnapshot): JointApplication {
    return new JointApplication(snapshot);
  }

  static createDraft(input: {
    id: string;
    jointActivityId: string;
    applicantId: string;
    now: Date;
  }): JointApplication {
    return new JointApplication({
      id: input.id,
      jointActivityId: input.jointActivityId,
      applicantId: input.applicantId,
      status: JointApplicationStatus.DRAFT,
      formRef: null,
      participantsSnapshot: [],
      consentSnapshotHash: null,
      sharedNote: null,
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
  get applicantId(): string {
    return this.snapshot.applicantId;
  }
  get status(): JointApplicationStatus {
    return this.snapshot.status;
  }

  toSnapshot(): JointApplicationSnapshot {
    return { ...this.snapshot };
  }

  /** 提交：校验共享同意硬前提（由调用方传入期望哈希） */
  submit(
    machine: JointApplicationStateMachine,
    input: {
      formRef: JointApplicationFormRef;
      participantsSnapshot: readonly string[];
      consentSnapshotHash: string;
      expectedConsentHash: string;
      sharedNote?: string | null;
      now: Date;
    },
  ): boolean {
    if (this.snapshot.status !== JointApplicationStatus.DRAFT) {
      throw new JointDomainError('JNT_APP_NOT_DRAFT', '仅草稿态联合申请可提交');
    }
    if (input.consentSnapshotHash !== input.expectedConsentHash) {
      throw new JointDomainError(
        'JNT_APP_CONSENT_MISMATCH',
        '共享同意快照不匹配，拒绝提交（不得自动勾选或沿用其他活动同意）',
      );
    }
    const ok = this.transition(machine, JointApplicationEvent.SUBMIT, input.now);
    if (ok) {
      this.snapshot = {
        ...this.snapshot,
        formRef: input.formRef,
        participantsSnapshot: input.participantsSnapshot,
        consentSnapshotHash: input.consentSnapshotHash,
        sharedNote: input.sharedNote ?? null,
      };
    }
    return ok;
  }

  archive(machine: JointApplicationStateMachine, now: Date): boolean {
    if (this.snapshot.status !== JointApplicationStatus.SUBMITTED) {
      throw new JointDomainError('JNT_APP_NOT_SUBMITTED', '仅已提交联合申请可归档');
    }
    return this.transition(machine, JointApplicationEvent.ARCHIVE, now);
  }

  private transition(
    machine: JointApplicationStateMachine,
    event: JointApplicationEvent,
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
