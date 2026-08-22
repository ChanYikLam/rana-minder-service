import type { CorrectionStatus } from '../state-machines/correction-state-machine';

/** 客观错误类型（AUD-001/002：仅客观事实错误可纠错） */
export const ObjectiveErrorType = {
  /** 对象写错（张冠李戴的对象归属） */
  WRONG_OBJECT: 'WRONG_OBJECT',
  /** 姓名错误 */
  WRONG_NAME: 'WRONG_NAME',
  /** 经历错误 */
  WRONG_EXPERIENCE: 'WRONG_EXPERIENCE',
  /** 时间地点错误 */
  WRONG_TIME_PLACE: 'WRONG_TIME_PLACE',
  /** 评语张冠李戴 */
  MISATTRIBUTED_COMMENT: 'MISATTRIBUTED_COMMENT',
  /** 违规内容 */
  VIOLATION_CONTENT: 'VIOLATION_CONTENT',
} as const;

export type ObjectiveErrorType = (typeof ObjectiveErrorType)[keyof typeof ObjectiveErrorType];

/** 不可变历史事件（批准/驳回/撤回均保留；AUD-001/002/010） */
export interface CorrectionHistoryEvent {
  readonly at: string;
  readonly type: 'DRAFTED' | 'SUBMITTED' | 'APPROVED' | 'REJECTED' | 'WITHDRAWN' | 'MARKED_OVERDUE';
  readonly by: string;
  readonly note?: string;
}

/** 批准结果（追加原值/新值；原记录保留；AUD-001） */
export interface CorrectionDecision {
  readonly decidedBy: string;
  readonly decidedAt: string;
  readonly reason: string;
  readonly oldValue: string;
  readonly newValue: string;
}

/**
 * 纠错聚合（SRS-SM-AUD-001）。
 *
 * 只追加：原值/原附件/原操作历史保留；终态不可覆盖；
 * 需改变当前关系时另走正式 Casdoor 关系变更（不提供按历史一键重放，AUD-001/MEM-016）。
 */
export interface Correction {
  readonly correctionId: string;
  /** 原提交人（撤回仅本人；不可变） */
  readonly applicantId: string;
  /** 记录原作者（作者回避：不得单独批准自己的错误） */
  readonly authorId: string;
  /** 目标业务记录 */
  readonly targetRecord: {
    readonly objectType: string;
    readonly objectId: string;
    /** 目标记录所属社团（跨社团改写判定；AUD-010） */
    readonly ownerClubId: string;
    readonly fieldKey: string;
    readonly recordVersion: number;
  };
  /** 客观错误类型（主观评价争议 → 拒绝提交） */
  readonly objectiveErrorType: ObjectiveErrorType;
  /** 期望修正与原因 */
  readonly expectedCorrection: string;
  /** 证据引用（不扩大原权限） */
  readonly evidenceRefs: readonly string[];
  /** 处理期限（超管配置；逾期仅标记） */
  readonly deadlineAt: string;
  readonly status: CorrectionStatus;
  readonly version: number;
  readonly createdAt: string;
  readonly submittedAt: string | null;
  readonly overdueMarkedAt: string | null;
  readonly decision: CorrectionDecision | null;
  readonly history: readonly CorrectionHistoryEvent[];
}
