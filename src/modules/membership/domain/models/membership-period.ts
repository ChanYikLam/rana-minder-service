import type { MembershipPeriodStatus } from '../state-machines/membership-period.state-machine';

/**
 * 成员经历段（SRS-SM-MEM-001，MEM-001/013/018）。
 *
 * 聚合根：一段独立的"社团 × 学生"成员经历。历史成员重入必须新建经历段，
 * 不恢复旧部门、旧职位或旧权限（MEM-013）；每段经历的历史事件不可变、不得删除。
 *
 * 当前 Group 关系以 Casdoor 为权威：本地保存业务意图、处理中状态与不可变历史；
 * 回读确认前不开放成员权限（ORG-027）。
 */

/** 入社来源（REC-026、JNT-016、MEM-007、SRS-SM-MEM-001 转换 1） */
export const MembershipEntrySource = {
  /** 普通录取邀请接受 */
  RECRUIT_OFFER: 'RECRUIT_OFFER',
  /** 联合录取/联合加入邀请接受 */
  JOINT_OFFER: 'JOINT_OFFER',
  /** 常规入社邀请接受（MEM-018：社团＋可选初始部门整体接受） */
  REGULAR_INVITE: 'REGULAR_INVITE',
  /** 非成员职位任命组合操作（加入社团＋加入部门＋任命职位，MEM-007） */
  APPOINTMENT_COMBO: 'APPOINTMENT_COMBO',
} as const;

export type MembershipEntrySource =
  (typeof MembershipEntrySource)[keyof typeof MembershipEntrySource];

/** 组合写入目标关系（社团 Group 必有；常规邀请至多一个初始部门；组合任命另含职位） */
export interface MembershipRelationTarget {
  readonly kind: 'CLUB' | 'DEPARTMENT' | 'POSITION';
  /** 稳定标识：社团 id / 部门 id / 职位 id（不使用名称定位，ORG-013） */
  readonly refId: string;
}

/** 成员身份生效意图进度（ORG-027：写后定向回读确认前不开放权限） */
export const ActivationProgress = {
  /** 成员生效处理中（页面显示；保持最小权限） */
  PROCESSING: 'PROCESSING',
  /** 15 分钟内失败/响应不确定：保持处理中并带失败/重试标志 */
  FAILED_PENDING_RETRY: 'FAILED_PENDING_RETRY',
} as const;

export type ActivationProgress = (typeof ActivationProgress)[keyof typeof ActivationProgress];

/**
 * 外部写入方向围栏（per-period 任务围栏）：同一经历段同一时刻只允许一个方向的
 * Casdoor 外部写入在途（激活写入 vs 补偿移除互斥），防止方向相反的外部副作用
 * 竞态留下"本地已收口而外部关系仍在"的泄漏窗口。
 * - 同方向重入允许（任务重执行/崩溃恢复按同方向幂等续跑）；
 * - 异方向在期时拒绝并提示稍后重试（IFC-ERR-007）。
 */
export const ActivationExternalPhase = {
  /** 待执行（初始；允许任一方向占围栏） */
  PENDING: 'PENDING',
  /** 激活写入在途（resolve 占用） */
  WRITING: 'WRITING',
  /** 补偿移除在途（compensate 占用） */
  COMPENSATING: 'COMPENSATING',
} as const;

export type ActivationExternalPhase =
  (typeof ActivationExternalPhase)[keyof typeof ActivationExternalPhase];

/** 生效意图（进入处理中时同事务创建；先回读后重试，无需本人再次接受） */
export interface MemberActivationState {
  readonly progress: ActivationProgress;
  readonly phase: ActivationExternalPhase;
  /**
   * 围栏占用起始时间（phase != PENDING 时存在）：异方向任务遇占用时，
   * 超过 15 分钟（ORG-027 自动重试窗口）允许超时释放并接管，防止外部写入
   * 任务永久滞留导致异方向无限期 Busy。
   */
  readonly fencedAt?: string;
  /** 已尝试次数（每次先回读再执行） */
  readonly attemptCount: number;
  /** 最近一次尝试时间 */
  readonly lastAttemptAt?: string;
  /** 失败原因（技术性，脱敏后保存） */
  readonly lastError?: string;
}

/** 退出/移除申请状态（SRS-SM-MEM-001 转换 5；决定与审批历史不可变） */
export const DepartureRequestStatus = {
  /** 待审批（本人二次确认已完成后进入；期间可撤回，撤回与审批并发只一个成功） */
  PENDING_APPROVAL: 'PENDING_APPROVAL',
  /** 已批准待执行（级联移除任务已建；回读前原关系通常保持有效 ORG-027） */
  APPROVED: 'APPROVED',
  /** 已驳回（必须填写原因；通知成员） */
  REJECTED: 'REJECTED',
  /** 已撤回（撤回后不可再审批，MEM-005） */
  WITHDRAWN: 'WITHDRAWN',
} as const;

export type DepartureRequestStatus =
  (typeof DepartureRequestStatus)[keyof typeof DepartureRequestStatus];

/** 退出/移除种类（主动退出 MEM-002/005；管理员移除 MEM-008） */
export const DepartureKind = {
  /** 成员本人主动退出（需负责人/人事批准＋本人二次确认） */
  VOLUNTARY: 'VOLUNTARY',
  /** 社团主动移除（负责人/人事按层级；原因＋二次确认；不能移除自己） */
  REMOVAL: 'REMOVAL',
} as const;

export type DepartureKind = (typeof DepartureKind)[keyof typeof DepartureKind];

/** 退出/移除执行进度（转换 5→6→7 的执行侧收口） */
export const DepartureExecution = {
  /** 级联移除待执行/执行中 */
  PENDING: 'PENDING',
  /** 全部移除并回读确认（经历实际结束） */
  COMPLETED: 'COMPLETED',
  /** 自动重试收口为失败：原关系确认完整有效，恢复当前成员，允许人工重试 */
  FAILED_RESTORED: 'FAILED_RESTORED',
} as const;

export type DepartureExecution = (typeof DepartureExecution)[keyof typeof DepartureExecution];

/**
 * 归档的历史决定记录（决定与审批历史不可变）：同一经历段的退出/移除申请
 * 被驳回/撤回后再次提交时，前次决定的结构化字段归档于此，不丢失。
 */
export interface DepartureDecisionRecord {
  readonly kind: DepartureKind;
  readonly requestStatus: 'REJECTED' | 'WITHDRAWN';
  readonly requestedBy: string;
  readonly decidedBy: string | null;
  readonly decidedAt: string | null;
  readonly rejectionReason: string | null;
}

/** 退出/移除决定与执行快照（原子保存；回读前原关系通常保持有效 ORG-027） */
export interface MemberDepartureState {
  readonly kind: DepartureKind;
  readonly requestStatus: DepartureRequestStatus;
  /** 移除必填原因（MEM-008）；主动退出原因可选 */
  readonly reason: string | null;
  /** 发起人（本人 / 有权管理员） */
  readonly requestedBy: string;
  /** 二次确认时间（主动退出发起必须已有；移除由操作者二次确认） */
  readonly secondConfirmedAt: string | null;
  /** 审批人/决定人（批准/驳回留痕；不能自审） */
  readonly decidedBy: string | null;
  readonly decidedAt: string | null;
  /** 驳回原因（驳回必填） */
  readonly rejectionReason: string | null;
  /** 决定时的关系快照（该社团全部部门/职位；级联执行范围） */
  readonly snapshot: readonly MembershipRelationTarget[];
  /** 执行进度 */
  readonly execution: DepartureExecution;
  /** 级联尝试次数（逐项幂等；同一经历只结束一次） */
  readonly attemptCount: number;
  /** 最近一次执行失败原因（技术性，脱敏） */
  readonly lastError?: string;
  /** 失败恢复当前成员的时间（转换 7） */
  readonly restoredAt?: string;
  /** 前次被驳回/撤回决定的归档（结构化保留，F5：不得随新申请覆盖丢失） */
  readonly priorDecisions: readonly DepartureDecisionRecord[];
}

/**
 * 不可变历史事件（接受和退出历史不得删除；REC-026~028、JNT-016、ORG-026）.
 * 只允许追加，不修改、不删除既有事件。
 */
export interface MembershipHistoryEvent {
  readonly at: string;
  readonly type:
    | 'ENTRY_STARTED' // 进入成员生效处理中（转换 1）
    | 'ACTIVATION_CONFIRMED' // 回读确认 → 当前成员（转换 2）
    | 'ACTIVATION_RETRY_KEPT_PROCESSING' // 15 分钟内失败保持处理中（转换 3）
    | 'ENTRY_COMPENSATED' // 补偿成功回到非成员/历史成员（转换 4）
    | 'DEPARTURE_REQUESTED' // 退出申请提交（二次确认完成）
    | 'DEPARTURE_WITHDRAWN'
    | 'DEPARTURE_APPROVED' // 批准 → 退出处理中
    | 'DEPARTURE_REJECTED'
    | 'REMOVAL_DECIDED' // 管理员移除受理 → 退出处理中
    | 'DEPARTURE_RETRY_KEPT_PROCESSING' // 级联移除未全部确认，保持退出处理中（转换 6 保持分支）
    | 'EXIT_EXECUTION_FAILED_RESTORED' // 执行失败恢复当前成员（转换 7）
    | 'EXTERNAL_CHANGE' // Casdoor 外部直接变更（ORG-026/MEM-016）
    | 'PERIOD_ENDED'; // 经历实际结束 → 历史成员（转换 6/8）
  readonly by: string;
  readonly note?: string;
  /**
   * Casdoor 外部变更的可信上游时间（MEM-016）：能获取可靠上游时间时记录；
   * 否则省略并以检测时间（at）承担，标记原始生效时间未知。
   */
  readonly upstreamAt?: string;
  /**
   * 外部直接移除社团 Group 后残留的子级关系（ORG-030/MEM-016）：
   * 标记同步异常且不自动删除，等待人工修复。
   */
  readonly residualTargets?: readonly MembershipRelationTarget[];
}

/**
 * 成员经历聚合（SRS-SM-MEM-001）。
 *
 * 状态语义（对齐接口清单 SM-MEM-001 摘要 non_member→pending_effective→active
 * →exiting→exited 与 SRS §8.1 明细）：
 * - ACTIVATION_PROCESSING：成员生效处理中（最小权限，不开放成员能力）；
 * - CURRENT_MEMBER：当前成员（回读确认后权限开放）；
 * - DEPARTURE_PROCESSING：退出处理中（级联移除中；原关系通常仍有效 ORG-027）；
 * - HISTORICAL_MEMBER：历史成员（当前关系全部移除并回读确认，历史保留）；
 * - ENTRY_COMPENSATED：入社补偿收口——草稿作废、从未成为当前成员；主体对外呈现
 *   非成员（首次进入）或保持历史成员（重入），接受/任命事实经历史事件保留
 *   （SRS-SM-MEM-001 转换 4 目标态"非成员或历史成员"在本聚合的落点）。
 */
export interface MembershipPeriod {
  readonly periodId: string;
  /** 社团 */
  readonly clubId: string;
  /** 学生账号（同一学生多段经历关联同一账号，MEM-013） */
  readonly subjectId: string;
  /** 当前状态 */
  readonly status: MembershipPeriodStatus;
  /** 版本（单胜者竞争：比较并交换，IFC-GEN-007） */
  readonly version: number;
  /** 入社来源与业务引用（邀请 id / 组合任命命令 id） */
  readonly entrySource: MembershipEntrySource;
  readonly entryRef: string;
  /** 成员业务生效时间 = 接受时间/组合任命确认时间（REC-026） */
  readonly businessEffectiveAt: string;
  /** 经历实际开始（回读确认成功时落笔；转换 2） */
  readonly actualStartAt: string | null;
  /** 经历实际结束（级联移除回读确认/外部移除收口时落笔；转换 6/8） */
  readonly actualEndAt: string | null;
  /** 计划结束时间（MEM-010/012：仅记录，绝不驱动自动卸任或撤权） */
  readonly plannedEndAt: string | null;
  /** 进入时组合写入目标（社团 Group ＋ 可选初始部门/职位 Group 任务） */
  readonly entryTargets: readonly MembershipRelationTarget[];
  /** 生效意图（进入处理中后存在；激活确认后保留供追溯） */
  readonly activation: MemberActivationState | null;
  /** 退出/移除决定与执行（当前成员后才可能出现） */
  readonly departure: MemberDepartureState | null;
  /** 外部移除后存在残留子级关系（同步异常标记，不自动删除 ORG-030） */
  readonly hasResidualAnomaly: boolean;
  /** 不可变历史（追加式，不得删除或改写既有事件） */
  readonly history: readonly MembershipHistoryEvent[];
}
