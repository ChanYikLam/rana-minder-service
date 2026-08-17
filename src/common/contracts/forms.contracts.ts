/**
 * 动态表单域 HTTP 契约类型
 *
 * 端点事实基线：docs/specification/接口清单-HTTP端点-v1.0.md §13
 * 逻辑契约：IFC-SM-024~025、SRS-SM-FORM-001~002、DATA-FRM-*（JSONB 规范化）
 *
 * 传输规则：
 * - designer save 使用 expectedVersion 乐观锁；不匹配 → 409 IFC-ERR-008。
 * - 提交类接口使用 idempotencyKey 幂等；同键同摘要返回原结果。
 */

import type { ApiListResponse } from './api-envelope';

export type FormFieldType =
  | 'text'
  | 'textarea'
  | 'number'
  | 'select'
  | 'multi_select'
  | 'radio'
  | 'checkbox'
  | 'date'
  | 'datetime'
  | 'file'
  | 'image'
  | 'array';

export type FormFieldPermission = 'read_write' | 'read_only' | 'hidden';

export interface FormField {
  id?: string;
  key: string;
  label: string;
  type: FormFieldType;
  required?: boolean;
  permission: FormFieldPermission;
  options?: string[];
  validation?: Record<string, unknown>;
  /** 动态表单答案必须按表单版本规范化校验（IFC-DATA-005），拒绝任意 JSON/JSONPath/秘密字段 */
  [index: string]: unknown;
}

export type FormDefinitionStatus = 'draft' | 'published' | 'deprecated' | 'archived';

export interface FormVersion {
  version: number;
  status: 'draft' | 'published' | 'deprecated';
  publishedAt: string | null;
  fields: FormField[];
}

/** GET /api/org/:clubId/forms 响应 item */
export interface FormListItem {
  id: string;
  title: string;
  status: FormDefinitionStatus;
  version: number;
  updatedAt: string;
}

/** GET /api/org/:clubId/forms/:formId 响应 data */
export interface FormDetail {
  id: string;
  title: string;
  status: FormDefinitionStatus;
  clubId: string | null;
  versions: FormVersion[];
}

/** GET /api/org/:clubId/forms/designer/:formId 响应 data */
export interface FormDesignerState {
  id: string;
  title: string;
  status: FormDefinitionStatus;
  fields: FormField[];
  version: number;
}

/** POST /api/org/:clubId/forms/designer/:formId/save 请求 input */
export interface SaveFormDraftInput {
  fields: FormField[];
  version?: number;
  expectedVersion?: number;
}

export interface SaveFormDraftResult {
  id: string;
  version: number;
  status: 'draft';
  savedAt: string;
}

export interface PublishFormInput {
  version?: number;
}

export interface PublishFormResult {
  id: string;
  version: number;
  status: 'published';
  publishedAt: string;
}

export interface DeprecateFormResult {
  id: string;
  status: 'deprecated';
  deprecatedAt: string;
}

export interface ReuseFormResult {
  id: string;
  status: 'draft';
  version: number;
}

export interface CloneFormInput {
  title?: string;
}

export interface CloneFormResult {
  id: string;
  title: string;
  status: 'draft';
  version: number;
}

export type FormSubmissionStatus = 'draft' | 'checking' | 'submitted' | 'deleted' | 'revision' | 'locked';

/** 表单提交完整对象（FormSubmission） */
export interface FormSubmission {
  id: string;
  formId: string;
  version: number;
  idempotencyKey: string;
  fields: FormField[];
  data: Record<string, unknown>;
  status: 'submitted';
  submittedAt: string;
}

export interface SubmitFormVersionInput {
  formData?: Record<string, unknown>;
  version?: number;
  idempotencyKey?: string;
}

export interface SubmitFormInput {
  version?: number;
  answers?: Record<string, unknown>;
  idempotencyKey?: string;
}

export interface SubmitFormResult {
  id: string;
  formId: string;
  version: number;
  status: 'submitted';
  submittedAt: string;
}

export type FormListResult = ApiListResponse<FormListItem>;
