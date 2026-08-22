/**
 * 招新表单提交端口（recruitment 应用层；依赖 4.1 表单提交）。
 *
 * 申请提交绑定 4.1 表单提交；本端口抽象读取提交视图，避免直接耦合 form 模块。
 * 当前用桩，后续可适配 form 的 FORM_SUBMISSION_REPOSITORY。
 */

export interface RecruitmentFormSubmissionView {
  readonly id: string;
  readonly status: string;
  readonly submittedBy: string;
}

export interface RecruitmentFormPort {
  loadSubmission(input: {
    readonly formId: string;
    readonly submissionId: string;
  }): Promise<RecruitmentFormSubmissionView | null>;
}

export class StubRecruitmentForm implements RecruitmentFormPort {
  private readonly submissions = new Map<string, RecruitmentFormSubmissionView>();

  seed(submission: RecruitmentFormSubmissionView): void {
    this.submissions.set(`${submission.id}`, submission);
  }

  async loadSubmission(input: {
    readonly formId: string;
    readonly submissionId: string;
  }): Promise<RecruitmentFormSubmissionView | null> {
    return this.submissions.get(input.submissionId) ?? null;
  }
}
