import type { DepartmentRelationStatus } from '../state-machines/department-relation.state-machine';

/**
 * 部门/职位关系段聚合（SRS-SM-MEM-002，ORG-020/021/026/027/030/034，MEM-003~016）。
 *
 * 聚合根：一条"社团 × 成员 × 部门（或职位）"关系段。复合调岗/加入部门＋任职
 * 作为单一业务命令提交，但按目标拆成多条关系段并行推进、同组收口
 * （changeGroupId 关联；部分写入不得只完成一半，MEM-009/ORG-034）。
 *
 * 当前 Group 关系以 Casdoor 为权威：本地保存业务意图、处理中状态与不可变历史；
 * 回读确认前不开放新权限（ORG-027）。外部直接增删以 Casdoor 当前结果为准，
 * 追加外部变更历史、不自动改回（MEM-016）。
 */

/** 关系种类：部门成员关系 / 职位任命关系 */
export const RelationKind = {
  DEPARTMENT: 'DEPARTMENT',
  POSITION: 'POSITION',
} as const;

export type RelationKind = (typeof RelationKind)[keyof typeof RelationKind];

/** 变更业务类型（ORG-021/023/024/034；复合调岗为单一业务命令 MEM-009） */
export const RelationChangeType = {
  /** 加入部门 */
  JOIN_DEPARTMENT: 'JOIN_DEPARTMENT',
  /** 任命职位 */
  APPOINT_POSITION: 'APPOINT_POSITION',
  /** 加入部门＋任职（组合任命，单一业务命令 MEM-007） */
  JOIN_DEPARTMENT_WITH_POSITION: 'JOIN_DEPARTMENT_WITH_POSITION',
  /** 调动移出部门（退部） */
  LEAVE_DEPARTMENT: 'LEAVE_DEPARTMENT',
  /** 免职/卸任职位 */
  REVOKE_POSITION: 'REVOKE_POSITION',
  /** 跨部门调动（移出原部门＋加入目标部门，整体执行不得半完成） */
  TRANSFER_DEPARTMENT: 'TRANSFER_DEPARTMENT',
} as const;

export type RelationChangeType = (typeof RelationChangeType)[keyof typeof RelationChangeType];

/** 组合写入方向（与 Casdoor Group 写入一一对应） */
export interface RelationTargetStep {
  readonly kind: RelationKind;
  readonly refId: string;
  readonly direction: 'add' | 'remove';
}

/**
 * 任期记录（MEM-010/014）：每次任命建立独立任期。
 * - 计划开始/结束：业务意图值，绝不驱动自动卸任（MEM-010/012）；
 * - 实际开始：回读确认成功时落笔；实际结束：结束回读确认/连任交接时落笔；
 * - 默认当前学年（academicYear 由配置学年开始月份推导）；
 * - 连任创建新任期：旧任期数据不可变、不延长、不覆盖（MEM-014）。
 */
export interface PositionTenure {
  readonly tenureId: string;
  /** 计划开始/结束（意图值；plannedEnd 不驱动卸任） */
  readonly plannedStartAt: string;
  readonly plannedEndAt: string;
  /** 实际开始/结束（回读事实） */
  readonly actualStartAt: string | null;
  readonly actualEndAt: string | null;
  /** 所属学年标签（默认当前学年；如 "2025-2026"） */
  readonly academicYear: string;
  /** 连任来源：上一任期 id（首任为 null） */
  readonly reappointmentOfTenureId: string | null;
  /** 建立来源业务命令 id（幂等追溯） */
  readonly sourceChangeId: string;
}

/** 变更处理中意图（R1 进入时同事务创建；先回读后重试 ORG-027） */
export const RelationChangeProgress = {
  /** 处理中 */
  PROCESSING: 'PROCESSING',
  /** 15 分钟窗口内失败/响应不确定：保持处理中并带失败标志 */
  FAILED_PENDING_RETRY: 'FAILED_PENDING_RETRY',
  /** 补偿进行中（部分写入逆序补偿） */
  COMPENSATING: 'COMPENSATING',
} as const;

export type RelationChangeProgress =
  (typeof RelationChangeProgress)[keyof typeof RelationChangeProgress];

export interface RelationChangeState {
  /** 业务命令类型 */
  readonly changeType: RelationChangeType;
  /** 单一业务命令组 id（复合调岗的多条关系段共享同一组 id） */
  readonly changeGroupId: string;
  /** 目标写入步骤（本段承担的部分） */
  readonly targetSteps: readonly RelationTargetStep[];
  /** 发起人（有权管理员或已批准申请的执行链路） */
  readonly submittedBy: string;
  readonly submittedAt: string;
  readonly progress: RelationChangeProgress;
  /** 已尝试次数（每次先回读再执行） */
  readonly attemptCount: number;
  /** 自动重试截止（15 分钟窗口；ORG-027） */
  readonly retryDeadlineAt: string | null;
  /** 最近失败原因（脱敏后保存） */
  readonly lastError?: string;
}

/** 结束处理中决定（R4；决定历史不可变） */
export interface RelationEndState {
  readonly endKind:
    | 'LEAVE_DEPARTMENT' // 退部（含调动移出）
    | 'RESIGN_POSITION' // 辞职（批准后）
    | 'DISMISS_POSITION' // 免职
    | 'TRANSFER_OUT'; // 跨部门调动的移出侧
  readonly reason: string | null;
  readonly requestedBy: string;
  readonly requestedAt: string;
  readonly progress: 'PENDING' | 'FAILED_RESTORED';
  readonly attemptCount: number;
  readonly lastError?: string;
}

/** 外部变更来源标记（R7/MEM-016：Casdoor 直接增删对账） */
export interface ExternalChangeRecord {
  readonly at: string;
  /** 可信上游时间（无法获取时省略并以检测时间承担） */
  readonly upstreamAt?: string;
  readonly direction: 'add' | 'remove';
  /** 对账后落定状态 */
  readonly settledAs: 'CURRENTLY_VALID' | 'HISTORICAL_ENDED' | 'SYNC_ANOMALY';
  /** 非法状态说明（零负责人/孤立职位等） */
  readonly illegality?: string;
  /** 外部事件幂等键（重复事件不重复历史） */
  readonly externalEventKey?: string;
}

/** 不可变历史事件（只追加，不修改、不删除） */
export interface RelationHistoryEvent {
  readonly at: string;
  readonly type:
    | 'CHANGE_STARTED' // R1 进入变更处理中
    | 'CHANGE_CONFIRMED' // R2 回读确认 → 当前有效
    | 'CHANGE_RETRY_KEPT_PROCESSING' // 自环：失败保持处理中
    | 'CHANGE_COMPENSATED' // R3 补偿成功回原状态
    | 'END_STARTED' // R4 进入结束处理中
    | 'END_CONFIRMED' // R5 移除回读确认 → 历史结束
    | 'END_RETRY_KEPT_PROCESSING' // 自环：移除未全部确认，保持结束处理中
    | 'END_FAILED_RESTORED' // R6 执行失败恢复当前有效
    | 'EXTERNAL_CHANGE' // R7 Casdoor 外部直接增删
    | 'ANOMALY_MARKED' // 转同步异常
    | 'ANOMALY_RESOLVED'; // R8 人工修复收口
  readonly by: string;
  readonly note?: string;
  /** 外部变更明细（type=EXTERNAL_CHANGE 时存在） */
  readonly external?: ExternalChangeRecord;
}

/** 同步异常元数据（最小权限收敛 + 等待人工修复） */
export interface SyncAnomalyState {
  /** 异常原因（残留关系/非法状态/补偿未确认等） */
  readonly reason: string;
  /** 已执行的最小权限收敛动作说明 */
  readonly minimizedTo: readonly string[];
  readonly markedAt: string;
  /** 异常处置任务唯一键（重复标记幂等） */
  readonly anomalyKey: string;
}

/**
 * 部门/职位关系段聚合。
 *
 * NO_RELATION 状态用于承载"补偿后回到无关系"的历史痕迹段（SRS R3 目标态）：
 * 该段从未生效（actualStart 为空），保留尝试历史供追溯；新发起加入时优先
 * 复活该段进入 CHANGE_PROCESSING（同 club×subject×ref 唯一活跃段约束见仓储）。
 */
export interface DepartmentRelation {
  readonly relationId: string;
  readonly clubId: string;
  readonly subjectId: string;
  /** 部门 id 或职位 id（稳定标识，不用名称定位 ORG-013） */
  readonly refId: string;
  readonly kind: RelationKind;
  readonly status: DepartmentRelationStatus;
  /** 版本（单胜者竞争 IFC-GEN-007） */
  readonly version: number;
  /** 变更处理中意图（确认/补偿收口后保留供追溯） */
  readonly change: RelationChangeState | null;
  /** 结束处理中决定（收口后保留供追溯） */
  readonly end: RelationEndState | null;
  /** 任期序列（POSITION 类；连任追加新任期，历史任期不可变） */
  readonly tenures: readonly PositionTenure[];
  /** 关系实际开始（R2/R7 回读确认时落笔） */
  readonly actualStartAt: string | null;
  /** 关系实际结束（R5/R7/R8 收口时落笔） */
  readonly actualEndAt: string | null;
  readonly endReason: string | null;
  /** 同步异常元数据 */
  readonly anomaly: SyncAnomalyState | null;
  /** 不可变历史（追加式） */
  readonly history: readonly RelationHistoryEvent[];
}

/** 当前生效任期（最后一个实际开始且未实际结束的任期；无则 null） */
export function currentTenureOf(relation: DepartmentRelation): PositionTenure | null {
  for (let i = relation.tenures.length - 1; i >= 0; i -= 1) {
    const t = relation.tenures[i];
    if (t.actualStartAt !== null && t.actualEndAt === null) return t;
  }
  return null;
}
