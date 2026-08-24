import type { DepartmentApplicationStatus } from '../state-machines/department-application.state-machine';
import type { RelationKind } from './department-relation';

/**
 * 部门关系申请聚合（SRS-SM-MEM-003，MEM-009/017、ORG-027/036）。
 *
 * 成员本人提交加入/退出/跨部门调动申请；审批通过后启动 Casdoor 关系变更；
 * 跨部门调动整体执行、不得半完成；回读确认全部目标才"已生效"。
 */

/** 申请类型（join=加入部门 / leave=退出部门 / transfer=跨部门调动） */
export const DepartmentApplicationType = {
  JOIN: 'JOIN',
  LEAVE: 'LEAVE',
  TRANSFER: 'TRANSFER',
} as const;

export type DepartmentApplicationType =
  (typeof DepartmentApplicationType)[keyof typeof DepartmentApplicationType];

/** 审批记录（决定历史不可变；重复同决定幂等） */
export interface ApplicationApprovalState {
  readonly decision: 'APPROVE' | 'REJECT';
  /** 审批人当前角色（角色型待办的处置留痕 MEM-017） */
  readonly decidedByRole: string;
  readonly decidedBy: string;
  readonly decidedAt: string;
  /** 驳回原因（驳回必填） */
  readonly rejectReason: string | null;
}

/** 执行尝试状态（A5~A8；先回读后重试 ORG-027） */
export interface ApplicationExecutionState {
  readonly status:
    | 'PENDING_START' // 已批准待执行
    | 'PROCESSING' // 执行处理中
    | 'FAILED_ORIGINAL_PRESERVED'; // 执行失败保持原关系
  /** 业务幂等键基础（重试沿用原键＋尝试号，不重新审批） */
  readonly idempotencyBase: string;
  readonly attemptCount: number;
  readonly lastError?: string;
  readonly startedAt?: string;
}

/** 不可变申请历史事件 */
export interface ApplicationHistoryEvent {
  readonly at: string;
  readonly type:
    | 'SUBMITTED' // A1 提交
    | 'WITHDRAWN' // A2 撤回
    | 'REJECTED' // A3 驳回
    | 'APPROVED' // A4 批准
    | 'EXECUTION_STARTED' // A5 启动执行
    | 'EFFECTIVE' // A6 生效
    | 'EXECUTION_FAILED_PRESERVED' // A7 失败保持原关系
    | 'RETRY_STARTED'; // A8 人工重试
  readonly by: string;
  readonly note?: string;
}

/**
 * 部门关系申请聚合根。
 *
 * snapshot：提交时的当前部门关系快照（调动须列出选择退出的原部门）。
 */
export interface DepartmentApplication {
  readonly applicationId: string;
  readonly clubId: string;
  /** 申请人＝成员本人 */
  readonly applicantId: string;
  readonly type: DepartmentApplicationType;
  /** 目标部门（join/transfer 必填；leave 为 null） */
  readonly targetDeptId: string | null;
  /** 调动/退出时明确选择退出的原部门 id（leave/transfer 必填） */
  readonly leaveDeptIds: readonly string[];
  readonly reason: string | null;
  readonly status: DepartmentApplicationStatus;
  /** 版本（单胜者竞争：撤回/批准/驳回只一个成功 IFC-GEN-007） */
  readonly version: number;
  /** 提交时当前关系快照 */
  readonly snapshot: readonly { kind: RelationKind; refId: string }[];
  readonly submittedAt: string;
  readonly approval: ApplicationApprovalState | null;
  readonly execution: ApplicationExecutionState | null;
  readonly history: readonly ApplicationHistoryEvent[];
}
