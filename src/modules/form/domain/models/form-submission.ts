/**
 * 表单提交聚合（form 域；FORM-002、DATA-FRM-001/002）。
 *
 * 一条提交对应一个已发布版本（form_id + version_number）；提交者在草稿态填写，
 * 提交后进入不可变提交记录（SUBMITTED），后续更正走修订（追加修订快照，保留历史）。
 *
 * 不变量：
 * - DRAFT → SUBMITTED 单向提交；已提交态不允许重复提交（须修订）；
 * - 修订只在 SUBMITTED 下允许，追加 SubmissionRevision，当前 values 指向最新修订；
 * - 答案值由应用层按不可变版本重验（validateFormAnswer），聚合不持有字段定义。
 */

import type { FormScope } from './form-scope';
import {
  FormSubmissionState,
  FormSubmissionStateMachine,
  FormSubmissionEvent,
  DefaultFormSubmissionStateMachine,
} from '../state-machines/form-submission.state-machine';

export type FormAnswerValue =
  string | number | boolean | string[] | readonly FormAnswerRow[] | null;

export interface FormAnswerRow {
  readonly [fieldId: string]: FormAnswerValue;
}

export interface SubmissionRevision {
  readonly revision: number;
  readonly values: Record<string, FormAnswerValue>;
  readonly revisedBy: string;
  readonly revisedAt: Date;
}

export interface FormSubmissionSnapshot {
  readonly id: string;
  readonly formId: string;
  readonly versionNumber: number;
  readonly scope: FormScope;
  readonly submittedBy: string;
  /** 当前（最新修订）答案值 */
  readonly values: Record<string, FormAnswerValue>;
  readonly status: FormSubmissionState;
  /** 当前修订号（从 1 起） */
  readonly revisionNumber: number;
  /** 修订历史（含初始提交） */
  readonly revisions: readonly SubmissionRevision[];
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export class FormSubmission {
  private constructor(private snapshot: FormSubmissionSnapshot) {}

  static fromSnapshot(snapshot: FormSubmissionSnapshot): FormSubmission {
    return new FormSubmission(snapshot);
  }

  /** 新建草稿提交（填写中，未提交） */
  static createDraft(input: {
    id: string;
    formId: string;
    versionNumber: number;
    scope: FormScope;
    submittedBy: string;
    values: Record<string, FormAnswerValue>;
    now: Date;
  }): FormSubmission {
    return new FormSubmission({
      id: input.id,
      formId: input.formId,
      versionNumber: input.versionNumber,
      scope: input.scope,
      submittedBy: input.submittedBy,
      values: input.values,
      status: FormSubmissionState.DRAFT,
      revisionNumber: 1,
      revisions: [
        {
          revision: 1,
          values: input.values,
          revisedBy: input.submittedBy,
          revisedAt: input.now,
        },
      ],
      createdAt: input.now,
      updatedAt: input.now,
    });
  }

  get id(): string {
    return this.snapshot.id;
  }

  get formId(): string {
    return this.snapshot.formId;
  }

  get versionNumber(): number {
    return this.snapshot.versionNumber;
  }

  get scope(): FormScope {
    return this.snapshot.scope;
  }

  get submittedBy(): string {
    return this.snapshot.submittedBy;
  }

  get values(): Record<string, FormAnswerValue> {
    return this.snapshot.values;
  }

  get status(): FormSubmissionState {
    return this.snapshot.status;
  }

  get revisionNumber(): number {
    return this.snapshot.revisionNumber;
  }

  get revisions(): readonly SubmissionRevision[] {
    return this.snapshot.revisions;
  }

  get createdAt(): Date {
    return this.snapshot.createdAt;
  }

  toSnapshot(): FormSubmissionSnapshot {
    return { ...this.snapshot };
  }

  /** 提交（DRAFT → SUBMITTED） */
  submit(machine: FormSubmissionStateMachine, now: Date): boolean {
    return this.transition(machine, FormSubmissionEvent.SUBMIT, now).allowed;
  }

  /** 修订门：仅已提交态可修订 */
  canRevise(machine: FormSubmissionStateMachine): boolean {
    const result = machine.transition({
      event: FormSubmissionEvent.REVISE,
      currentState: this.snapshot.status,
    });
    return result.allowed;
  }

  /** 修订（SUBMITTED 下追加修订快照，状态不变） */
  revise(newValues: Record<string, FormAnswerValue>, revisedBy: string, now: Date): boolean {
    if (!this.canRevise(new DefaultFormSubmissionStateMachine())) {
      return false;
    }
    const nextRevision = this.snapshot.revisionNumber + 1;
    this.snapshot = {
      ...this.snapshot,
      values: newValues,
      status: FormSubmissionState.SUBMITTED,
      revisionNumber: nextRevision,
      revisions: [
        ...this.snapshot.revisions,
        { revision: nextRevision, values: newValues, revisedBy, revisedAt: now },
      ],
      updatedAt: now,
    };
    return true;
  }

  private transition(
    machine: FormSubmissionStateMachine,
    event: FormSubmissionEvent,
    now: Date,
  ): { allowed: boolean } {
    const result = machine.transition({
      event,
      currentState: this.snapshot.status,
    });
    if (!result.allowed) {
      return { allowed: false };
    }
    this.snapshot = {
      ...this.snapshot,
      status: result.nextState,
      updatedAt: now,
    };
    return { allowed: true };
  }
}
