/**
 * 表单定义存储端口（form 域；SRS-SM-FORM-001 聚合持久化边界）。
 *
 * 根（form_definitions）+ 版本（form_versions）+ 预览测试（form_preview_tests）+
 * 模板库发布申请（form_template_publications）同事务读写（IFC-TX-001）；
 * 已发布/已停用版本不可更新（SRS-INV-011），状态转换以 SQL 状态守卫保证
 * 并发单胜者（失败 → IFC-ERR-010）；指针变化以根乐观版本守卫（IFC-GEN-007）。
 */

import type { FormDefinitionSnapshot } from '../../domain/models/form-definition';
import type { FormVersionSnapshot } from '../../domain/models/form-version';
import type { FormVersionState } from '../../domain/state-machines/form-version.state-machine';
import type { FormScope } from '../../domain/models/form-scope';
import type {
  TemplatePublicationSnapshot,
  TemplatePublicationState,
} from '../../domain/models/template-publication';

export interface FormPreviewTestSnapshot {
  readonly id: string;
  readonly formId: string;
  readonly versionNumber: number;
  readonly result: 'PASSED' | 'FAILED';
  readonly summary: Record<string, unknown>;
  readonly testedBy: string;
  readonly testedAt: Date;
}

export interface FormDefinitionRepository {
  // ----- 根 -----
  loadRoot(id: string): Promise<FormDefinitionSnapshot | null>;
  listByScope(scope: FormScope): Promise<FormDefinitionSnapshot[]>;
  /** 乐观保存：根版本不匹配（0 行）→ 调用方映射 IFC-ERR-008 */
  saveRoot(snapshot: FormDefinitionSnapshot, expectedVersion: number): Promise<void>;

  // ----- 版本 -----
  loadVersion(formId: string, versionNumber: number): Promise<FormVersionSnapshot | null>;
  loadLatestVersion(formId: string): Promise<FormVersionSnapshot | null>;
  loadVersions(formId: string): Promise<FormVersionSnapshot[]>;
  /** 新建版本行（无冲突键，直接插入） */
  insertVersion(snapshot: FormVersionSnapshot): Promise<void>;
  /** 状态转换保存：以期望状态守卫（0 行 → 并发单胜者失败 IFC-ERR-010） */
  saveVersionWithStatusGuard(
    snapshot: FormVersionSnapshot,
    expectedStatus: FormVersionState,
  ): Promise<void>;

  // ----- 预览/测试 -----
  savePreviewTest(snapshot: FormPreviewTestSnapshot): Promise<void>;
  loadPreviewTest(formId: string, versionNumber: number): Promise<FormPreviewTestSnapshot | null>;

  // ----- 模板库发布申请 -----
  saveTemplatePublication(snapshot: TemplatePublicationSnapshot): Promise<void>;
  loadTemplatePublication(id: string): Promise<TemplatePublicationSnapshot | null>;
  listTemplatePublications(
    status: TemplatePublicationState | null,
  ): Promise<TemplatePublicationSnapshot[]>;
  /** 审核裁决：以 PENDING 状态守卫（0 行 → 并发单胜者失败 IFC-ERR-010） */
  saveTemplatePublicationWithStatusGuard(snapshot: TemplatePublicationSnapshot): Promise<void>;
}
