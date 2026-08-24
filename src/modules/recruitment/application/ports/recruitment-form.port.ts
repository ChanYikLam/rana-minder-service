/**
 * 招新表单提交端口（recruitment 应用层；依赖 4.1 表单提交）。
 *
 * 申请提交绑定 4.1 表单提交；本端口抽象读取提交视图，避免直接耦合 form 模块。
 *
 * 结果区分三态（评审意见：避免"提交不存在"与"归属不符"语义混淆）：
 * - `found`：快照存在、归属请求表单且版本匹配；
 * - `not-found`：提交快照不存在，或**引用的表单版本已作废**（携带 reason 区分）；
 * - `forbidden`：快照存在但**不属于请求表单**（跨表单读取，use case 层按无权处理）。
 *
 * **校验逻辑共享**（评审意见）：resolveRecruitmentFormSubmission 为生产适配器
 * （FormBackedRecruitmentForm）与测试桩（StubRecruitmentForm）共用的单一校验函数，
 * 保证测试能覆盖生产中的 forbidden/版本不符路径，避免语义漂移。
 */

export interface RecruitmentFormSubmissionView {
  readonly id: string;
  readonly status: string;
  readonly submittedBy: string;
  /** 归属表单（可选；Stub seed 提供后即启用归属校验，与生产一致） */
  readonly formId?: string;
  /** 表单版本（可选；提供后即启用版本校验，与生产一致） */
  readonly versionNumber?: number;
}

export type RecruitmentFormLoadResult =
  | { readonly outcome: 'found'; readonly submission: RecruitmentFormSubmissionView }
  | {
      readonly outcome: 'not-found';
      /** 不存在原因（评审意见：区分"提交缺失"与"版本已作废"，供 use case 文案） */
      readonly reason?: 'submission-missing' | 'version-stale';
    }
  | { readonly outcome: 'forbidden' };

export interface RecruitmentFormLoadInput {
  readonly formId: string;
  readonly submissionId: string;
  /** 引用的表单版本（可选；提供时须与视图版本核对，防引用已修订/作废版本） */
  readonly versionNumber?: number;
}

/**
 * 共享校验（生产/测试桩单源）：
 * - 视图缺失 → not-found(submission-missing)；
 * - 视图归属 formId 与请求不符 → forbidden（跨表单读取）；
 * - 视图版本与请求不符 → not-found(version-stale)（引用已修订/作废版本）。
 */
export function resolveRecruitmentFormSubmission(
  view: RecruitmentFormSubmissionView | null,
  input: RecruitmentFormLoadInput,
): RecruitmentFormLoadResult {
  if (view === null) {
    return { outcome: 'not-found', reason: 'submission-missing' };
  }
  if (view.formId !== undefined && view.formId !== input.formId) {
    return { outcome: 'forbidden' };
  }
  if (
    input.versionNumber !== undefined &&
    view.versionNumber !== undefined &&
    view.versionNumber !== input.versionNumber
  ) {
    return { outcome: 'not-found', reason: 'version-stale' };
  }
  return { outcome: 'found', submission: view };
}

export interface RecruitmentFormPort {
  loadSubmission(input: RecruitmentFormLoadInput): Promise<RecruitmentFormLoadResult>;
}

export class StubRecruitmentForm implements RecruitmentFormPort {
  private readonly submissions = new Map<string, RecruitmentFormSubmissionView>();

  seed(submission: RecruitmentFormSubmissionView): void {
    this.submissions.set(`${submission.id}`, submission);
  }

  async loadSubmission(input: RecruitmentFormLoadInput): Promise<RecruitmentFormLoadResult> {
    // 与生产 FormBackedRecruitmentForm 共用同一校验函数（评审意见：语义一致，
    // 测试可覆盖 forbidden/版本不符路径）
    const view = this.submissions.get(input.submissionId) ?? null;
    return resolveRecruitmentFormSubmission(view, input);
  }
}
