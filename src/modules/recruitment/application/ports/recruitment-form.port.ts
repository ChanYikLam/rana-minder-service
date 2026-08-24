/**
 * 招新表单提交端口（recruitment 应用层；依赖 4.1 表单提交）。
 *
 * 申请提交绑定 4.1 表单提交；本端口抽象读取提交视图，避免直接耦合 form 模块。
 *
 * 结果区分三态（评审意见：避免"提交不存在"与"归属不符"语义混淆）：
 * - `found`：快照存在且归属请求表单；
 * - `not-found`：提交快照不存在；
 * - `forbidden`：快照存在但**不属于请求表单**（跨表单读取，use case 层
 *   按无权处理，而非误报"不存在"）。
 */

export interface RecruitmentFormSubmissionView {
  readonly id: string;
  readonly status: string;
  readonly submittedBy: string;
}

export type RecruitmentFormLoadResult =
  | { readonly outcome: 'found'; readonly submission: RecruitmentFormSubmissionView }
  | { readonly outcome: 'not-found' }
  | { readonly outcome: 'forbidden' };

export interface RecruitmentFormPort {
  loadSubmission(input: {
    readonly formId: string;
    readonly submissionId: string;
  }): Promise<RecruitmentFormLoadResult>;
}

export class StubRecruitmentForm implements RecruitmentFormPort {
  private readonly submissions = new Map<string, RecruitmentFormSubmissionView>();

  seed(submission: RecruitmentFormSubmissionView): void {
    this.submissions.set(`${submission.id}`, submission);
  }

  async loadSubmission(input: {
    readonly formId: string;
    readonly submissionId: string;
  }): Promise<RecruitmentFormLoadResult> {
    const submission = this.submissions.get(input.submissionId);
    if (submission === undefined) {
      return { outcome: 'not-found' };
    }
    return { outcome: 'found', submission };
  }
}
