/**
 * 招新表单集成适配（recruitment infrastructure；4.4b 真集成收口）。
 *
 * 将 StubRecruitmentForm 替换为对 form 模块 FORM_SUBMISSION_REPOSITORY 的
 * 真实委托（报名表走 4.1 真实表单提交链路）：
 *
 * - loadSubmission 委托 form 提交仓储按 submissionId 读取快照；
 * - **校验与 Stub 共享**：resolveRecruitmentFormSubmission 统一处理归属
 *   （formId 不符 → forbidden）与版本（versionNumber 不符 → not-found/version-stale）；
 * - 视图映射仅暴露招新所需字段（id/status/submittedBy/formId/versionNumber），
 *   不泄露答案明细（FormSubmissionSnapshot.values 属于表单域，不向招新域透出）。
 */

import type { FormSubmissionRepository } from '../../form/application/ports/form-submission-repository.port';
import {
  resolveRecruitmentFormSubmission,
  type RecruitmentFormLoadResult,
  type RecruitmentFormPort,
  type RecruitmentFormSubmissionView,
} from '../application/ports/recruitment-form.port';

export class FormBackedRecruitmentForm implements RecruitmentFormPort {
  constructor(private readonly submissions: FormSubmissionRepository) {}

  async loadSubmission(input: {
    readonly formId: string;
    readonly submissionId: string;
    readonly versionNumber?: number;
  }): Promise<RecruitmentFormLoadResult> {
    const snapshot = await this.submissions.load(input.submissionId);
    if (snapshot === null) {
      // 统一走共享校验函数（评审意见：唯一入口，not-found/submission-missing 语义单一）
      return resolveRecruitmentFormSubmission(null, input);
    }
    // 仅透出招新所需字段（不泄露答案明细）；formId/versionNumber 供共享校验使用
    const view: RecruitmentFormSubmissionView = {
      id: snapshot.id,
      status: snapshot.status,
      submittedBy: snapshot.submittedBy,
      formId: snapshot.formId,
      versionNumber: snapshot.versionNumber,
    };
    return resolveRecruitmentFormSubmission(view, input);
  }
}
