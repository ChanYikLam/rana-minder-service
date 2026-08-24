/**
 * 招新表单集成适配（recruitment infrastructure；4.4b 真集成收口）。
 *
 * 将 StubRecruitmentForm 替换为对 form 模块 FORM_SUBMISSION_REPOSITORY 的
 * 真实委托（报名表走 4.1 真实表单提交链路）：
 *
 * - loadSubmission 委托 form 提交仓储按 submissionId 读取快照；
 * - **归属校验**：快照 formId 必须等于请求 formId——不符返回 `forbidden`
 *   （评审意见：use case 层按无权处理，而非误报"提交不存在"）；
 * - 视图映射仅暴露招新所需字段（id/status/submittedBy），不泄露答案明细
 *   （FormSubmissionSnapshot.values 含报名内容，属于表单域，不向招新域透出）。
 */

import type { FormSubmissionRepository } from '../../form/application/ports/form-submission-repository.port';
import type {
  RecruitmentFormLoadResult,
  RecruitmentFormPort,
} from '../application/ports/recruitment-form.port';

export class FormBackedRecruitmentForm implements RecruitmentFormPort {
  constructor(private readonly submissions: FormSubmissionRepository) {}

  async loadSubmission(input: {
    readonly formId: string;
    readonly submissionId: string;
  }): Promise<RecruitmentFormLoadResult> {
    const snapshot = await this.submissions.load(input.submissionId);
    if (snapshot === null) {
      return { outcome: 'not-found' };
    }
    // 归属校验：提交必须属于请求表单（防跨表单读取；不符按 forbidden 处理）
    if (snapshot.formId !== input.formId) {
      return { outcome: 'forbidden' };
    }
    return {
      outcome: 'found',
      submission: {
        id: snapshot.id,
        status: snapshot.status,
        submittedBy: snapshot.submittedBy,
      },
    };
  }
}
