/**
 * 常规入社邀请状态机（SRS-SM-MEM-004，IFC-SM-023）。
 *
 * 状态：新建 → 待处理 → 已接受待生效 → 已生效 / 同步失败待重试 / 高优先级同步异常；
 * 待处理 → 已拒绝 / 已撤回 / 已过期 / 目标已成为成员。
 *
 * 核心不变量（MEM-018、ORG-027）：
 * - 接受只允许**整体接受**（不可拆分），进入"已接受待生效"；
 * - Casdoor 社团及可选部门关系**全部回读确认**后才"已生效"并开放权限；
 * - 只确认部分关系时不得成功：按组合关系补偿（先回读后重试）；
 * - 无法确认且无法补偿到非成员 → 高优先级同步异常（冻结普通重试、维持最小权限、通知超管）；
 * - 已拒绝/已撤回/已过期/目标已成为成员可重新发出（新邀请对象，旧保留）。
 */
export const RoutineInvitationStatus = {
  NEW: 'NEW',
  /** 待处理（可接受/拒绝/撤回/过期） */
  PENDING: 'PENDING',
  /** 已接受待生效（整体接受；Casdoor 回读确认前不开放权限） */
  ACCEPTED_PENDING_ACTIVATION: 'ACCEPTED_PENDING_ACTIVATION',
  /** 已生效（社团及可选部门关系全部回读确认） */
  ACTIVATED: 'ACTIVATED',
  /** 同步失败待重试（外部失败可重试；先回读后重试，无需本人重接） */
  SYNC_FAILED_PENDING_RETRY: 'SYNC_FAILED_PENDING_RETRY',
  /** 高优先级同步异常（无法确认且无法补偿到非成员；冻结普通重试） */
  HIGH_PRIORITY_SYNC_ANOMALY: 'HIGH_PRIORITY_SYNC_ANOMALY',
  REJECTED: 'REJECTED',
  WITHDRAWN: 'WITHDRAWN',
  EXPIRED: 'EXPIRED',
  /** 目标已成为成员（接受时回读确认已通过其他路径成为本社团成员） */
  TARGET_ALREADY_MEMBER: 'TARGET_ALREADY_MEMBER',
} as const;

export type RoutineInvitationStatus =
  (typeof RoutineInvitationStatus)[keyof typeof RoutineInvitationStatus];

/** 可重发状态（已拒绝/已撤回/已过期/目标已成为成员；MEM-018） */
export const REISSUABLE_STATUSES: readonly RoutineInvitationStatus[] = [
  RoutineInvitationStatus.REJECTED,
  RoutineInvitationStatus.WITHDRAWN,
  RoutineInvitationStatus.EXPIRED,
  RoutineInvitationStatus.TARGET_ALREADY_MEMBER,
];

/** 转换非法异常（IFC-ERR-007 状态冲突） */
export class IllegalRoutineTransitionError extends Error {
  constructor(from: RoutineInvitationStatus, to: RoutineInvitationStatus) {
    super(`IFC-ERR-007: 非法常规邀请状态转换 ${from} -> ${to}`);
    this.name = 'IllegalRoutineTransitionError';
  }
}

/** 转换规则（SRS-SM-MEM-004 8.4 明细；重发为创建新对象，不在此表） */
const TRANSITIONS: Readonly<Record<RoutineInvitationStatus, readonly RoutineInvitationStatus[]>> = {
  [RoutineInvitationStatus.NEW]: [RoutineInvitationStatus.PENDING],
  [RoutineInvitationStatus.PENDING]: [
    RoutineInvitationStatus.ACCEPTED_PENDING_ACTIVATION,
    RoutineInvitationStatus.TARGET_ALREADY_MEMBER,
    RoutineInvitationStatus.REJECTED,
    RoutineInvitationStatus.WITHDRAWN,
    RoutineInvitationStatus.EXPIRED,
  ],
  [RoutineInvitationStatus.ACCEPTED_PENDING_ACTIVATION]: [
    RoutineInvitationStatus.ACTIVATED,
    RoutineInvitationStatus.SYNC_FAILED_PENDING_RETRY,
    RoutineInvitationStatus.HIGH_PRIORITY_SYNC_ANOMALY,
  ],
  [RoutineInvitationStatus.SYNC_FAILED_PENDING_RETRY]: [
    RoutineInvitationStatus.SYNC_FAILED_PENDING_RETRY, // 重试仍失败保持重试（自环；避免第二次起抛非法转换）
    RoutineInvitationStatus.ACCEPTED_PENDING_ACTIVATION, // 重试回到待生效继续回读
    RoutineInvitationStatus.ACTIVATED, // 已实际全部达成直接收口
    RoutineInvitationStatus.HIGH_PRIORITY_SYNC_ANOMALY, // 无法确认且无法补偿
  ],
  // 高优先级同步异常：冻结普通重试（无重试自环边）；任何后续处置先回读且幂等
  // （SRS-SM-MEM-004），处置后按回读事实落到对应状态：
  [RoutineInvitationStatus.HIGH_PRIORITY_SYNC_ANOMALY]: [
    RoutineInvitationStatus.ACTIVATED, // 处置回读确认关系已全部达成 → 直接收口已生效
    RoutineInvitationStatus.ACCEPTED_PENDING_ACTIVATION, // 处置确认可恢复同步 → 回待生效继续激活流程
    RoutineInvitationStatus.TARGET_ALREADY_MEMBER, // 处置回读确认目标已通过其他路径成为成员 → 收口
  ],
  [RoutineInvitationStatus.ACTIVATED]: [],
  [RoutineInvitationStatus.REJECTED]: [],
  [RoutineInvitationStatus.WITHDRAWN]: [],
  [RoutineInvitationStatus.EXPIRED]: [],
  [RoutineInvitationStatus.TARGET_ALREADY_MEMBER]: [],
};

/** 常规入社邀请状态机（纯规则；SRS-SM-MEM-004） */
export class RoutineInvitationStateMachine {
  canTransition(from: RoutineInvitationStatus, to: RoutineInvitationStatus): boolean {
    return TRANSITIONS[from].includes(to);
  }

  /** 执行转换；非法转换抛 IllegalRoutineTransitionError */
  transition(from: RoutineInvitationStatus, to: RoutineInvitationStatus): RoutineInvitationStatus {
    if (!this.canTransition(from, to)) {
      throw new IllegalRoutineTransitionError(from, to);
    }
    return to;
  }

  /** 可重新发出（MEM-018） */
  canReissue(status: RoutineInvitationStatus): boolean {
    return REISSUABLE_STATUSES.includes(status);
  }
}
