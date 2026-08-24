/**
 * 平台模板库发布申请聚合（form 域；FORM-010）。
 *
 * 社团负责人/人事可申请将自有表单发布到平台模板库；超级管理员审核。
 * 批准后物化平台 TEMPLATE 根（只含结构、字段与校验，不含提交数据、附件或
 * 内部人员信息，复制时清除对象选项），模板与来源副本独立演进。
 *
 * 不变量：PENDING → APPROVED/REJECTED 单向终态；并发裁决只有一个成功
 * （状态守卫单胜者）；驳回必须给原因；模板物化引用记录来源表单与版本。
 */

export const TemplatePublicationState = {
  PENDING: 'PENDING',
  APPROVED: 'APPROVED',
  REJECTED: 'REJECTED',
} as const;
export type TemplatePublicationState =
  (typeof TemplatePublicationState)[keyof typeof TemplatePublicationState];

export interface TemplatePublicationSnapshot {
  readonly id: string;
  readonly formId: string;
  /** 申请基于的来源发布版本 */
  readonly sourceVersion: number;
  readonly status: TemplatePublicationState;
  readonly note: string | null;
  readonly requestedBy: string;
  readonly requestedAt: Date;
  readonly decidedBy: string | null;
  readonly decidedAt: Date | null;
  readonly decisionReason: string | null;
  /** 批准后物化的平台模板根（null 表示未物化） */
  readonly templateFormId: string | null;
  readonly version: number;
}

export class TemplatePublication {
  private constructor(private snapshot: TemplatePublicationSnapshot) {}

  static fromSnapshot(snapshot: TemplatePublicationSnapshot): TemplatePublication {
    return new TemplatePublication(snapshot);
  }

  static create(input: {
    id: string;
    formId: string;
    sourceVersion: number;
    note: string | null;
    requestedBy: string;
    now: Date;
  }): TemplatePublication {
    return new TemplatePublication({
      id: input.id,
      formId: input.formId,
      sourceVersion: input.sourceVersion,
      status: TemplatePublicationState.PENDING,
      note: input.note,
      requestedBy: input.requestedBy,
      requestedAt: input.now,
      decidedBy: null,
      decidedAt: null,
      decisionReason: null,
      templateFormId: null,
      version: 0,
    });
  }

  get id(): string {
    return this.snapshot.id;
  }

  get formId(): string {
    return this.snapshot.formId;
  }

  get sourceVersion(): number {
    return this.snapshot.sourceVersion;
  }

  get status(): TemplatePublicationState {
    return this.snapshot.status;
  }

  get templateFormId(): string | null {
    return this.snapshot.templateFormId;
  }

  toSnapshot(): TemplatePublicationSnapshot {
    return { ...this.snapshot };
  }

  /** 超管批准：物化模板引用并推进至 APPROVED（终态） */
  approve(templateFormId: string, decidedBy: string, now: Date): boolean {
    if (this.snapshot.status !== TemplatePublicationState.PENDING) {
      return false;
    }
    this.snapshot = {
      ...this.snapshot,
      status: TemplatePublicationState.APPROVED,
      templateFormId,
      decidedBy,
      decidedAt: now,
      version: this.snapshot.version + 1,
    };
    return true;
  }

  /** 超管驳回：推进至 REJECTED（终态，须给原因） */
  reject(decisionReason: string, decidedBy: string, now: Date): boolean {
    if (this.snapshot.status !== TemplatePublicationState.PENDING) {
      return false;
    }
    this.snapshot = {
      ...this.snapshot,
      status: TemplatePublicationState.REJECTED,
      decidedBy,
      decidedAt: now,
      decisionReason,
      version: this.snapshot.version + 1,
    };
    return true;
  }
}
