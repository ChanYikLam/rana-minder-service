/**
 * 表单版本聚合（form 域；SRS-SM-FORM-001、DATA-FRM-001/002）。
 *
 * 一个版本一行（form_id + version_number 唯一）；草稿版本可被新草稿版本取代
 * （原子存新草稿版本），已发布/已停用版本内容不可更新、不可覆盖、不可直接恢复
 * （SRS-INV-011）；复用必须基于来源版本建新草稿并发布新版本号（PRD-OPT-043）。
 *
 * 不变量：
 * - DRAFT → PREVIEW_TESTING → DRAFT(publishable) → PUBLISHED → DEPRECATED 单向推进；
 * - publishable（可发布标志）只对 DRAFT 有意义，草稿变更/测试失败即失效；
 * - fields 为不可变定义快照（含结构/字段/校验/条件/权限），不含提交数据与附件。
 */

import type { FormFieldSet } from './form-field';
import type { FormVersionStateMachine } from '../state-machines/form-version.state-machine';
import { FormVersionEvent, FormVersionState } from '../state-machines/form-version.state-machine';

export interface FormVersionSnapshot {
  readonly id: string;
  readonly formId: string;
  readonly versionNumber: number;
  readonly status: FormVersionState;
  /** 可发布标志（只对 DRAFT 有意义） */
  readonly publishable: boolean;
  /** 不可变定义快照（结构/字段/校验/条件/权限） */
  readonly fields: FormFieldSet;
  /** 来源版本引用（复用/克隆/模板复制/模板库发布，FORM-005/010） */
  readonly sourceFormId: string | null;
  readonly sourceVersion: number | null;
  readonly publishedAt: Date | null;
  readonly publishedBy: string | null;
  readonly deprecatedAt: Date | null;
  readonly deprecatedBy: string | null;
  readonly createdBy: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export class FormVersion {
  private constructor(private snapshot: FormVersionSnapshot) {}

  static fromSnapshot(snapshot: FormVersionSnapshot): FormVersion {
    return new FormVersion(snapshot);
  }

  /** 新建草稿版本（t1 创建 / t6 复用 / t2 编辑产生的行；来源引用按调用方给定） */
  static createDraft(input: {
    id: string;
    formId: string;
    versionNumber: number;
    fields: FormFieldSet;
    sourceFormId: string | null;
    sourceVersion: number | null;
    createdBy: string;
    now: Date;
  }): FormVersion {
    return new FormVersion({
      id: input.id,
      formId: input.formId,
      versionNumber: input.versionNumber,
      status: FormVersionState.DRAFT,
      publishable: false,
      fields: input.fields,
      sourceFormId: input.sourceFormId,
      sourceVersion: input.sourceVersion,
      publishedAt: null,
      publishedBy: null,
      deprecatedAt: null,
      deprecatedBy: null,
      createdBy: input.createdBy,
      createdAt: input.now,
      updatedAt: input.now,
    });
  }

  /** 平台模板物化（审核批准）：直接落位 PUBLISHED v1（创建路径，非状态转换） */
  static createPublished(input: {
    id: string;
    formId: string;
    versionNumber: number;
    fields: FormFieldSet;
    sourceFormId: string | null;
    sourceVersion: number | null;
    publishedBy: string;
    now: Date;
  }): FormVersion {
    return new FormVersion({
      id: input.id,
      formId: input.formId,
      versionNumber: input.versionNumber,
      status: FormVersionState.PUBLISHED,
      publishable: false,
      fields: input.fields,
      sourceFormId: input.sourceFormId,
      sourceVersion: input.sourceVersion,
      publishedAt: input.now,
      publishedBy: input.publishedBy,
      deprecatedAt: null,
      deprecatedBy: null,
      createdBy: input.publishedBy,
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

  get status(): FormVersionState {
    return this.snapshot.status;
  }

  get publishable(): boolean {
    return this.snapshot.publishable;
  }

  get fields(): FormFieldSet {
    return this.snapshot.fields;
  }

  get sourceFormId(): string | null {
    return this.snapshot.sourceFormId;
  }

  get sourceVersion(): number | null {
    return this.snapshot.sourceVersion;
  }

  get publishedAt(): Date | null {
    return this.snapshot.publishedAt;
  }

  get deprecatedAt(): Date | null {
    return this.snapshot.deprecatedAt;
  }

  get createdAt(): Date {
    return this.snapshot.createdAt;
  }

  toSnapshot(): FormVersionSnapshot {
    return { ...this.snapshot };
  }

  /** 预览/测试（t3）：DRAFT → PREVIEW_TESTING */
  runPreviewTest(machine: FormVersionStateMachine, now: Date): boolean {
    return this.transition(machine, FormVersionEvent.RUN_PREVIEW_TEST, now).allowed;
  }

  /** 测试未通过（t3 结果收口）：PREVIEW_TESTING → DRAFT（publishable=false） */
  markPreviewFailed(machine: FormVersionStateMachine, now: Date): boolean {
    return this.transition(machine, FormVersionEvent.PREVIEW_TEST_FAILED, now).allowed;
  }

  /** 测试通过并返回发布准备（t4）：PREVIEW_TESTING → DRAFT（publishable=true，不自动发布） */
  markPreviewPassed(machine: FormVersionStateMachine, now: Date): boolean {
    return this.transition(machine, FormVersionEvent.PREVIEW_TEST_PASSED, now).allowed;
  }

  /** 发布不可变版本（t5）：DRAFT(publishable) → PUBLISHED，成为当前使用版本 */
  publish(machine: FormVersionStateMachine, publishedBy: string, now: Date): boolean {
    const result = this.transition(machine, FormVersionEvent.PUBLISH, now);
    if (!result.allowed) {
      return false;
    }
    this.snapshot = {
      ...this.snapshot,
      status: FormVersionState.PUBLISHED,
      publishable: false,
      publishedAt: now,
      publishedBy,
      updatedAt: now,
    };
    return true;
  }

  /** 停用（t7）：PUBLISHED → DEPRECATED，只阻止新提交，历史保留 */
  deprecate(machine: FormVersionStateMachine, deprecatedBy: string, now: Date): boolean {
    const result = this.transition(machine, FormVersionEvent.DEPRECATE, now);
    if (!result.allowed) {
      return false;
    }
    this.snapshot = {
      ...this.snapshot,
      status: FormVersionState.DEPRECATED,
      publishable: false,
      deprecatedAt: now,
      deprecatedBy,
      updatedAt: now,
    };
    return true;
  }

  /** t2 编辑前置门：仅 DRAFT 可被编辑（旧版本编辑拒绝） */
  canUpdate(machine: FormVersionStateMachine): boolean {
    const result = machine.transition({
      event: FormVersionEvent.UPDATE_DRAFT,
      currentState: this.snapshot.status,
      publishable: this.snapshot.publishable,
    });
    return result.allowed;
  }

  /** t6 复用来源门：仅 PUBLISHED/DEPRECATED 可作来源（原版本状态不变） */
  canBeReuseSource(machine: FormVersionStateMachine): boolean {
    const result = machine.transition({
      event: FormVersionEvent.REUSE,
      currentState: this.snapshot.status,
      publishable: false,
    });
    return result.allowed;
  }

  /** t8 稳定拒绝门：已停用版本直接恢复（RESTORE）一律拒绝 */
  restoreReason(machine: FormVersionStateMachine): string | null {
    const result = machine.transition({
      event: FormVersionEvent.RESTORE,
      currentState: this.snapshot.status,
      publishable: false,
    });
    return result.reason;
  }

  private transition(
    machine: FormVersionStateMachine,
    event: FormVersionEvent,
    now: Date,
  ): { allowed: boolean } {
    const result = machine.transition({
      event,
      currentState: this.snapshot.status,
      publishable: this.snapshot.publishable,
    });
    if (!result.allowed) {
      return { allowed: false };
    }
    this.snapshot = {
      ...this.snapshot,
      status: result.nextState,
      publishable: result.publishable,
      updatedAt: now,
    };
    return { allowed: true };
  }
}
