/**
 * 表单提交存储端口（form 域；FORM-002、SRS-SM-FORM-002）。
 *
 * 提交记录按 id 唯一；同一提交者对一个已发布版本仅允许一份提交（重复提交须走修订）。
 * 修订保存以修订号乐观守卫（IFC-GEN-007；并发修订单胜者失败 → IFC-ERR-008）。
 */

import type { FormSubmissionSnapshot } from '../../domain/models/form-submission';
import type { FormScope } from '../../domain/models/form-scope';

export interface FormSubmissionRepository {
  load(id: string): Promise<FormSubmissionSnapshot | null>;
  /** 同一提交者对一个版本的当前提交（用于重复提交拦截） */
  loadBySubmitter(
    formId: string,
    versionNumber: number,
    submittedBy: string,
  ): Promise<FormSubmissionSnapshot | null>;
  listByScope(scope: FormScope): Promise<FormSubmissionSnapshot[]>;
  /** 按表单+作用域列出（作用域过滤下沉到存储层，避免跨 owner 数据进内存） */
  listByForm(formId: string, scope: FormScope): Promise<FormSubmissionSnapshot[]>;
  /** 新建提交行（id 冲突 → 调用方映射 IFC-ERR-008） */
  insert(snapshot: FormSubmissionSnapshot): Promise<void>;
  /** 修订保存：以期望修订号守卫（0 行 → 并发单胜者失败 IFC-ERR-008） */
  save(snapshot: FormSubmissionSnapshot, expectedRevision: number): Promise<void>;
}
