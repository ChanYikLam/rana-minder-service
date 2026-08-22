/**
 * 成员经历状态机（SRS-SM-MEM-001 §8.1，IFC-SM-020）.
 *
 * 状态：成员生效处理中 → 当前成员 → 退出处理中 → 历史成员；
 * 另有处理中自环（失败/重试标志）、补偿收口（ENTRY_COMPENSATED）与
 * 外部直接移除（当前成员 → 历史成员）。
 *
 * 核心不变量（ORG-027、MEM-002/005/008/013/016/018）：
 * - 回读确认前不得进入当前成员（不开放成员权限，最小权限）；
 * - 同一经历段只结束一次（PERIOD_ENDED 只发生一次）；
 * - 历史成员为终态：重入必须新建经历段，不复活本段（MEM-013）；
 * - 计划结束时间绝不驱动任何转换（MEM-010/012：无"到期自动卸任"出边）。
 */

export const MembershipPeriodStatus = {
  /** 成员生效处理中（页面显示；保持最小权限） */
  ACTIVATION_PROCESSING: 'ACTIVATION_PROCESSING',
  /** 当前成员 */
  CURRENT_MEMBER: 'CURRENT_MEMBER',
  /** 退出处理中 */
  DEPARTURE_PROCESSING: 'DEPARTURE_PROCESSING',
  /** 历史成员 */
  HISTORICAL_MEMBER: 'HISTORICAL_MEMBER',
  /** 入社补偿收口：草稿作废、从未成为当前成员（转换 4 的聚合内落点） */
  ENTRY_COMPENSATED: 'ENTRY_COMPENSATED',
} as const;

export type MembershipPeriodStatus =
  (typeof MembershipPeriodStatus)[keyof typeof MembershipPeriodStatus];

/** 进行中状态（同社团同用户同时最多一条；社团＋用户当前成员唯一） */
export const ACTIVE_PERIOD_STATUSES: readonly MembershipPeriodStatus[] = [
  MembershipPeriodStatus.ACTIVATION_PROCESSING,
  MembershipPeriodStatus.CURRENT_MEMBER,
  MembershipPeriodStatus.DEPARTURE_PROCESSING,
];

/** 终态（历史成员 / 补偿作废；均不再迁移） */
export const TERMINAL_PERIOD_STATUSES: readonly MembershipPeriodStatus[] = [
  MembershipPeriodStatus.HISTORICAL_MEMBER,
  MembershipPeriodStatus.ENTRY_COMPENSATED,
];

/** 转换非法异常（IFC-ERR-007 状态冲突） */
export class IllegalMembershipTransitionError extends Error {
  constructor(from: MembershipPeriodStatus, to: MembershipPeriodStatus) {
    super(`IFC-ERR-007: 非法成员经历状态转换 ${from} -> ${to}`);
    this.name = 'IllegalMembershipTransitionError';
  }
}

/**
 * 转换规则（SRS-SM-MEM-001 §8.1 全部转换；对齐 README"9 条转换"口径：
 * 状态出边＋两个进行中状态的失败/重试自环保持行）：
 * 1. 非成员/历史成员 → 处理中：由 EnterMembership 新建经历草稿承载；
 * 2. 处理中 → 当前成员：Casdoor 社团＋组合部门全部回读确认；
 * 3. 处理中 → 处理中（失败/重试标志）：15 分钟内失败或响应不确定；
 * 4. 处理中 → ENTRY_COMPENSATED：组合写入部分成功且补偿成功；
 * 5. 当前成员 → 退出处理中：主动退出获批或管理员移除受理；
 * 6. 退出处理中 → 历史成员：全部 Group 移除并回读确认；
 * 7. 退出处理中 → 当前成员：执行失败且原关系确认完整有效（恢复）；
 * 8. 当前成员 → 历史成员：Casdoor 外部直接移除社团 Group（对账收口）。
 */
const TRANSITIONS: Readonly<Record<MembershipPeriodStatus, readonly MembershipPeriodStatus[]>> = {
  [MembershipPeriodStatus.ACTIVATION_PROCESSING]: [
    MembershipPeriodStatus.CURRENT_MEMBER,
    MembershipPeriodStatus.ACTIVATION_PROCESSING, // 自环：失败/重试标志
    MembershipPeriodStatus.ENTRY_COMPENSATED,
  ],
  [MembershipPeriodStatus.CURRENT_MEMBER]: [
    MembershipPeriodStatus.DEPARTURE_PROCESSING,
    MembershipPeriodStatus.HISTORICAL_MEMBER, // 仅外部直接移除对账收口
  ],
  [MembershipPeriodStatus.DEPARTURE_PROCESSING]: [
    MembershipPeriodStatus.DEPARTURE_PROCESSING, // 自环：级联未全确认，保持退出处理中
    MembershipPeriodStatus.HISTORICAL_MEMBER,
    MembershipPeriodStatus.CURRENT_MEMBER, // 执行失败恢复（转换 7）
  ],
  // 终态无出边：历史成员重入新建经历段（MEM-013），补偿草稿不复活
  [MembershipPeriodStatus.HISTORICAL_MEMBER]: [],
  [MembershipPeriodStatus.ENTRY_COMPENSATED]: [],
};

/** 成员经历状态机（纯规则；SRS-SM-MEM-001） */
export class MembershipPeriodStateMachine {
  canTransition(from: MembershipPeriodStatus, to: MembershipPeriodStatus): boolean {
    const edges = TRANSITIONS[from];
    if (edges === undefined) return false; // 未知状态：一律视为不可转换（防御）
    return edges.includes(to);
  }

  /** 执行转换；非法转换抛 IllegalMembershipTransitionError */
  transition(from: MembershipPeriodStatus, to: MembershipPeriodStatus): MembershipPeriodStatus {
    if (!this.canTransition(from, to)) {
      throw new IllegalMembershipTransitionError(from, to);
    }
    return to;
  }

  isTerminal(status: MembershipPeriodStatus): boolean {
    return TERMINAL_PERIOD_STATUSES.includes(status);
  }

  /** 是否进行中（占用"社团×学生"唯一活跃位） */
  isActive(status: MembershipPeriodStatus): boolean {
    return ACTIVE_PERIOD_STATUSES.includes(status);
  }
}
