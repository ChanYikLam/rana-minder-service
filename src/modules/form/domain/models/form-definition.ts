/**
 * 表单根聚合（form 域；SRS-SM-FORM-001、DATA-FRM-001）。
 *
 * 根承载：作用域（platform/club/department）、表单族（businessFamily）、
 * 当前草稿指针与当前发布指针、乐观版本。版本内容与状态在 form_versions 行，
 * 根只维护"当前使用指针"（当前发布指针变化必须携带期望版本，IFC-GEN-007）。
 *
 * 不变量：
 * - 平台公共资料表与平台模板：超管维护；社团表单：社团负责人/人事；部门表：部门负责人；
 * - 已发布版本成为当前后，停用只撤销"新提交可选版本"，历史引用继续有效；
 * - 停用不删除历史定义、提交和附件（FORM-002/005）；复用创建新草稿并切换指针，
 *   原版本（含已停用）内容与状态不变。
 */

import type { FormScope } from './form-scope';
import { scopeKeyOf } from './form-scope';

export type FormKind = 'FORM' | 'TEMPLATE';

export interface FormDefinitionSnapshot {
  readonly id: string;
  readonly scope: FormScope;
  readonly kind: FormKind;
  readonly title: string;
  readonly description: string | null;
  readonly businessFamily: string | null;
  /** 当前草稿版本号（可编辑目标；无草稿为 null） */
  readonly currentDraftVersion: number | null;
  /** 当前发布版本号（新提交入口；无为 null） */
  readonly currentPublishedVersion: number | null;
  /** 根乐观版本（指针每次变化 +1） */
  readonly version: number;
  readonly createdBy: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export class FormDefinition {
  private constructor(private snapshot: FormDefinitionSnapshot) {}

  static fromSnapshot(snapshot: FormDefinitionSnapshot): FormDefinition {
    return new FormDefinition(snapshot);
  }

  static create(input: {
    id: string;
    scope: FormScope;
    kind: FormKind;
    title: string;
    description: string | null;
    businessFamily: string | null;
    createdBy: string;
    now: Date;
  }): FormDefinition {
    return new FormDefinition({
      id: input.id,
      scope: input.scope,
      kind: input.kind,
      title: input.title,
      description: input.description,
      businessFamily: input.businessFamily,
      currentDraftVersion: null,
      currentPublishedVersion: null,
      version: 0,
      createdBy: input.createdBy,
      createdAt: input.now,
      updatedAt: input.now,
    });
  }

  get id(): string {
    return this.snapshot.id;
  }

  get scope(): FormScope {
    return this.snapshot.scope;
  }

  get scopeKey(): string {
    return scopeKeyOf(this.snapshot.scope);
  }

  get kind(): FormKind {
    return this.snapshot.kind;
  }

  get title(): string {
    return this.snapshot.title;
  }

  get description(): string | null {
    return this.snapshot.description;
  }

  get businessFamily(): string | null {
    return this.snapshot.businessFamily;
  }

  get currentDraftVersion(): number | null {
    return this.snapshot.currentDraftVersion;
  }

  get currentPublishedVersion(): number | null {
    return this.snapshot.currentPublishedVersion;
  }

  get version(): number {
    return this.snapshot.version;
  }

  toSnapshot(): FormDefinitionSnapshot {
    return { ...this.snapshot };
  }

  /** 新草稿落位（t1 创建 / t2 编辑 / t6 复用）：指针指向新草稿，根版本 +1 */
  pointDraft(versionNumber: number, now: Date): void {
    this.snapshot = {
      ...this.snapshot,
      currentDraftVersion: versionNumber,
      version: this.snapshot.version + 1,
      updatedAt: now,
    };
  }

  /** 发布落位（t5）：新版本成为当前发布版本，草稿指针清空，根版本 +1 */
  pointPublished(versionNumber: number, now: Date): void {
    this.snapshot = {
      ...this.snapshot,
      currentPublishedVersion: versionNumber,
      currentDraftVersion: null,
      version: this.snapshot.version + 1,
      updatedAt: now,
    };
  }

  /** 停用落位（t7）：撤销当前发布指针（新提交入口），根版本 +1 */
  clearPublishedPointer(now: Date): void {
    this.snapshot = {
      ...this.snapshot,
      currentPublishedVersion: null,
      version: this.snapshot.version + 1,
      updatedAt: now,
    };
  }
}
