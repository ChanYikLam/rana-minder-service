/**
 * 招新申请聚合（recruitment 域；REC-002/003、FORM-011）。
 *
 * 同一学生同一批次一份申请，志愿属此申请；截止前可存草稿/编辑/重提（可追溯版本），
 * 修改截止后答案与志愿锁定；接受录取前可退出；身份异常单独标记（不自动判未录取）。
 * 不变量：志愿去重、数量满足活动规则、撤回后可重提、终态不可逆。
 */

import {
  ApplicationStatus,
  ApplicationStateMachine,
  ApplicationEvent,
  DefaultApplicationStateMachine,
} from '../state-machines/application.state-machine';
import { RecruitmentDomainError } from '../errors';

export interface DepartmentChoice {
  readonly departmentId: string;
  readonly order: number;
}

export interface FormSubmissionRef {
  readonly formId: string;
  readonly submissionId: string;
  readonly versionNumber: number;
}

export interface ApplicationRevision {
  readonly revision: number;
  readonly departmentChoices: readonly DepartmentChoice[];
  readonly formRef: FormSubmissionRef | null;
  readonly qualifySnapshot: unknown;
  readonly submittedAt: Date;
}

export interface ApplicationSnapshot {
  readonly id: string;
  readonly activityId: string;
  readonly channelId: string;
  readonly clubId: string;
  readonly applicantId: string;
  readonly status: ApplicationStatus;
  readonly departmentChoices: readonly DepartmentChoice[];
  readonly formRef: FormSubmissionRef | null;
  readonly qualifySnapshot: unknown;
  readonly revisions: readonly ApplicationRevision[];
  readonly revisionNumber: number;
  readonly supplementDueAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export class Application {
  private constructor(private snapshot: ApplicationSnapshot) {}

  static fromSnapshot(snapshot: ApplicationSnapshot): Application {
    return new Application(snapshot);
  }

  static createDraft(input: {
    id: string;
    activityId: string;
    channelId: string;
    clubId: string;
    applicantId: string;
    now: Date;
  }): Application {
    return new Application({
      id: input.id,
      activityId: input.activityId,
      channelId: input.channelId,
      clubId: input.clubId,
      applicantId: input.applicantId,
      status: ApplicationStatus.DRAFT,
      departmentChoices: [],
      formRef: null,
      qualifySnapshot: null,
      revisions: [],
      revisionNumber: 0,
      supplementDueAt: null,
      createdAt: input.now,
      updatedAt: input.now,
    });
  }

  get id(): string {
    return this.snapshot.id;
  }
  get status(): ApplicationStatus {
    return this.snapshot.status;
  }
  get revisionNumber(): number {
    return this.snapshot.revisionNumber;
  }
  get supplementDueAt(): Date | null {
    return this.snapshot.supplementDueAt;
  }
  get identityException(): boolean {
    return this.snapshot.status === ApplicationStatus.IDENTITY_EXCEPTION;
  }

  toSnapshot(): ApplicationSnapshot {
    return { ...this.snapshot };
  }

  /**
   * 草稿期保存答题内容（A2：POST :activityId/draft）。
   * 允许 DRAFT 与 WITHDRAWN（撤销回草稿后继续编辑）；其余状态拒绝——
   * SUBMITTED 须先撤销，IDENTITY_EXCEPTION 身份异常不可保存。
   */
  saveDraftAnswers(answers: unknown, now: Date): void {
    if (
      this.snapshot.status !== ApplicationStatus.DRAFT &&
      this.snapshot.status !== ApplicationStatus.WITHDRAWN
    ) {
      throw new Error('仅草稿态可保存报名草稿');
    }
    const existing = (this.snapshot.qualifySnapshot ?? {}) as Record<string, unknown>;
    this.snapshot = {
      ...this.snapshot,
      // 每次草稿保存是一次编辑版本（乐观锁递增；PG CAS 写以 revision 比对）
      revisionNumber: this.snapshot.revisionNumber + 1,
      qualifySnapshot: { ...existing, answers },
      updatedAt: now,
    };
  }

  /** 草稿期编辑志愿与表单引用（截止前） */
  editDraft(
    choices: readonly DepartmentChoice[],
    formRef: FormSubmissionRef | null,
    now: Date,
  ): void {
    if (this.snapshot.status !== ApplicationStatus.DRAFT) {
      throw new Error('仅草稿态可申请编辑');
    }
    this.snapshot = { ...this.snapshot, departmentChoices: choices, formRef, updatedAt: now };
  }

  submit(
    machine: ApplicationStateMachine,
    now: Date,
    input: {
      departmentChoices: readonly DepartmentChoice[];
      formRef: FormSubmissionRef | null;
      qualifySnapshot: unknown;
      minChoices: number;
      maxChoices: number;
    },
  ): boolean {
    this.validateChoices(input.departmentChoices, input.minChoices, input.maxChoices);
    return this.transitionTo(machine, ApplicationEvent.SUBMIT, now, {
      departmentChoices: input.departmentChoices,
      formRef: input.formRef,
      qualifySnapshot: input.qualifySnapshot,
    });
  }

  resubmit(
    machine: ApplicationStateMachine,
    now: Date,
    input: {
      departmentChoices: readonly DepartmentChoice[];
      formRef: FormSubmissionRef | null;
      qualifySnapshot: unknown;
      minChoices: number;
      maxChoices: number;
    },
  ): boolean {
    // 已退出可重提（SRS-SM-REC-003：截止前本人重提或个人恢复窗口内重提）；
    // 截止时间与恢复窗口有效性由应用层命令守卫，领域层仅校验状态合法性。
    if (
      this.snapshot.status !== ApplicationStatus.WITHDRAWN &&
      this.snapshot.status !== ApplicationStatus.EXITED
    ) {
      return false;
    }
    this.validateChoices(input.departmentChoices, input.minChoices, input.maxChoices);
    return this.transitionTo(machine, ApplicationEvent.RESUBMIT, now, {
      departmentChoices: input.departmentChoices,
      formRef: input.formRef,
      qualifySnapshot: input.qualifySnapshot,
    });
  }

  withdraw(now: Date): boolean {
    return this.transitionTo(
      new DefaultApplicationStateMachine(),
      ApplicationEvent.WITHDRAW,
      now,
      null,
    );
  }

  exit(now: Date): boolean {
    return this.transitionTo(
      new DefaultApplicationStateMachine(),
      ApplicationEvent.EXIT,
      now,
      null,
    );
  }

  markIdentityException(now: Date): boolean {
    return this.transitionTo(
      new DefaultApplicationStateMachine(),
      ApplicationEvent.MARK_IDENTITY_EXCEPTION,
      now,
      null,
    );
  }

  restoreIdentity(now: Date): boolean {
    return this.transitionTo(
      new DefaultApplicationStateMachine(),
      ApplicationEvent.RESTORE_IDENTITY,
      now,
      null,
    );
  }

  /** 最终未录取（负责人/人事结论，REC-044） */
  finalReject(now: Date): boolean {
    return this.transitionTo(
      new DefaultApplicationStateMachine(),
      ApplicationEvent.FINAL_REJECT,
      now,
      null,
    );
  }

  /** 发送录取邀请（REC-043；负责人/人事基于部门 ADMIT 发 offer） */
  sendAdmissionInvitation(now: Date): boolean {
    return this.transitionTo(
      new DefaultApplicationStateMachine(),
      ApplicationEvent.SEND_INVITATION,
      now,
      null,
    );
  }

  /** 接受录取（申请人本人；进入 ACCEPTED，成员生效由 4.5 衔接） */
  acceptInvitation(now: Date): boolean {
    return this.transitionTo(
      new DefaultApplicationStateMachine(),
      ApplicationEvent.ACCEPT_INVITATION,
      now,
      null,
    );
  }

  /** 补充窗口：标记截止（不切换主状态，FORM-011） */
  openSupplement(dueAt: Date, now: Date): void {
    if (this.snapshot.status !== ApplicationStatus.SUBMITTED) {
      throw new Error('仅已提交申请可开补充窗口');
    }
    this.snapshot = { ...this.snapshot, supplementDueAt: dueAt, updatedAt: now };
  }

  closeSupplement(now: Date): void {
    this.snapshot = { ...this.snapshot, supplementDueAt: null, updatedAt: now };
  }

  private validateChoices(
    choices: readonly DepartmentChoice[],
    minChoices: number,
    maxChoices: number,
  ): void {
    if (choices.length < minChoices || choices.length > maxChoices) {
      throw new RecruitmentDomainError(
        'REC_VALIDATION',
        `志愿数量须介于 ${minChoices} 与 ${maxChoices} 之间`,
      );
    }
    const seen = new Set<string>();
    for (const choice of choices) {
      if (typeof choice.departmentId !== 'string' || choice.departmentId.trim() === '') {
        throw new RecruitmentDomainError('REC_VALIDATION', '志愿部门标识不可为空');
      }
      if (seen.has(choice.departmentId)) {
        throw new RecruitmentDomainError('REC_VALIDATION', '志愿部门不可重复');
      }
      seen.add(choice.departmentId);
    }
  }

  private transitionTo(
    machine: ApplicationStateMachine,
    event: ApplicationEvent,
    now: Date,
    revisionInput: {
      departmentChoices: readonly DepartmentChoice[];
      formRef: FormSubmissionRef | null;
      qualifySnapshot: unknown;
    } | null,
  ): boolean {
    const result = machine.transition({ event, currentState: this.snapshot.status });
    if (!result.allowed) {
      return false;
    }
    const revisionNumber = this.snapshot.revisionNumber + 1;
    if (revisionInput !== null) {
      const revision: ApplicationRevision = {
        revision: revisionNumber,
        departmentChoices: revisionInput.departmentChoices,
        formRef: revisionInput.formRef,
        qualifySnapshot: revisionInput.qualifySnapshot,
        submittedAt: now,
      };
      this.snapshot = {
        ...this.snapshot,
        status: result.nextState,
        updatedAt: now,
        // 每次状态变迁都递增修订号，保证乐观锁（WHERE revision_number）能拦截
        // 并发的不同状态变更（如 withdraw 与 finalReject 竞争），避免丢失更新
        revisionNumber,
        departmentChoices: revisionInput.departmentChoices,
        formRef: revisionInput.formRef,
        qualifySnapshot: revisionInput.qualifySnapshot,
        revisions: [...this.snapshot.revisions, revision],
      };
    } else {
      this.snapshot = {
        ...this.snapshot,
        status: result.nextState,
        updatedAt: now,
        revisionNumber,
      };
    }
    return true;
  }
}
