/**
 * 表单提交/修订状态机（FORM-002；SRS-SM-FORM-002）。
 *
 * 状态：草稿（DRAFT）→ 已提交（SUBMITTED）。
 * - SUBMIT：DRAFT → SUBMITTED（提交后进入不可变提交记录，后续变更走修订）
 * - REVISE：SUBMITTED → SUBMITTED（追加修订快照，状态不变，保留历史）
 *
 * 创建（提交）与修订由聚合与用例编排；本机保证提交级转换前置条件与
 * 重复提交/未提交即修订的拒绝语义。
 */

export const FormSubmissionState = {
  DRAFT: 'DRAFT',
  SUBMITTED: 'SUBMITTED',
} as const;
export type FormSubmissionState = (typeof FormSubmissionState)[keyof typeof FormSubmissionState];

export const FormSubmissionEvent = {
  SUBMIT: 'SUBMIT',
  REVISE: 'REVISE',
} as const;
export type FormSubmissionEvent = (typeof FormSubmissionEvent)[keyof typeof FormSubmissionEvent];

export interface FormSubmissionTransitionInput {
  readonly event: FormSubmissionEvent;
  readonly currentState: FormSubmissionState;
}

export interface FormSubmissionTransitionResult {
  readonly allowed: boolean;
  readonly nextState: FormSubmissionState;
  /** 拒绝原因（不猜测下一状态，IFC-ERR-007 语义） */
  readonly reason: string | null;
}

export interface FormSubmissionStateMachine {
  transition(input: FormSubmissionTransitionInput): FormSubmissionTransitionResult;
}

export class DefaultFormSubmissionStateMachine implements FormSubmissionStateMachine {
  transition(input: FormSubmissionTransitionInput): FormSubmissionTransitionResult {
    const current = input.currentState;
    if (current === FormSubmissionState.DRAFT) {
      switch (input.event) {
        case FormSubmissionEvent.SUBMIT:
          return { allowed: true, nextState: FormSubmissionState.SUBMITTED, reason: null };
        case FormSubmissionEvent.REVISE:
          return {
            allowed: false,
            nextState: current,
            reason: '草稿未提交，不能修订',
          };
        default:
          return { allowed: false, nextState: current, reason: '当前状态不允许该事件' };
      }
    }
    if (current === FormSubmissionState.SUBMITTED) {
      switch (input.event) {
        case FormSubmissionEvent.SUBMIT:
          return {
            allowed: false,
            nextState: current,
            reason: '已提交，重复提交请走修订',
          };
        case FormSubmissionEvent.REVISE:
          return { allowed: true, nextState: FormSubmissionState.SUBMITTED, reason: null };
        default:
          return { allowed: false, nextState: current, reason: '当前状态不允许该事件' };
      }
    }
    return { allowed: false, nextState: current, reason: '未知的提交状态' };
  }
}
