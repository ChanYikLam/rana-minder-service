/**
 * 表单域业务审计端口（ENG-004 §4、AUD-003；FORM-012 数据生命周期协作）。
 *
 * 表单设计/发布/停用/复用/克隆/模板复制与模板库申请审核等关键变化必须与业务
 * 提交同边界落不可变审计事实；审计保存失败时原命令回滚。审计载荷只保存脱敏
 * 摘要与引用，不保存字段正文、附件、令牌或完整表单内容。
 */

export type FormAuditFactType =
  | 'FORM_DRAFT_CREATED'
  | 'FORM_DRAFT_UPDATED'
  | 'FORM_PREVIEW_TESTED'
  | 'FORM_PUBLISHED'
  | 'FORM_DEPRECATED'
  | 'FORM_REUSED'
  | 'FORM_CLONED'
  | 'FORM_TEMPLATE_COPIED'
  | 'FORM_TEMPLATE_CREATED'
  | 'FORM_TEMPLATE_PUBLICATION_REQUESTED'
  | 'FORM_TEMPLATE_PUBLICATION_DECIDED';

export interface FormAuditFact {
  readonly type: FormAuditFactType;
  /** 受影响主体（表单创建者/所属社团负责人等；表单域以表单 id 为主引用） */
  readonly subjectId: string;
  readonly occurredAt: Date;
  readonly actor: string;
  /** 脱敏摘要：只含稳定标识、状态、版本号与最小原因 */
  readonly summary: Record<string, unknown>;
  readonly traceId: string | null;
}

export interface FormAuditPort {
  record(fact: FormAuditFact): Promise<void>;
}
