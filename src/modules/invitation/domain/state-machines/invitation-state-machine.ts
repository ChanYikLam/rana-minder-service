/**
 * 普通/联合邀请状态机（SRS-SM-INV-001，IFC-SM-019）。
 *
 * 状态：新建 → 待处理 → 已接受/已拒绝/已撤回/已过期/强制失效。
 *
 * 核心不变量（REC-024/026、JNT-014~016）：
 * - **已接受不可逆**：不得恢复待处理、撤回或删除接受历史；
 * - 接受与撤回/过期/强制失效**单胜者竞争**（版本比较并交换）；
 * - 强制失效只作用于待处理邀请，已接受不受影响；
 * - 拒绝/过期/撤回后不得复活旧邀请：重发 = 创建全新邀请对象，旧邀请保留。
 */
export const InvitationStatus = {
  /** 新建（创建即发出 → 待处理；本模型创建命令直接置待处理） */
  NEW: 'NEW',
  /** 待处理（可接受/拒绝/撤回/过期/强制失效） */
  PENDING: 'PENDING',
  /** 已接受（不可逆；成员身份生效处理中/已生效由激活意图承接） */
  ACCEPTED: 'ACCEPTED',
  /** 已拒绝（本人拒绝） */
  REJECTED: 'REJECTED',
  /** 已撤回（发出方撤回） */
  WITHDRAWN: 'WITHDRAWN',
  /** 已过期（系统截止任务） */
  EXPIRED: 'EXPIRED',
  /** 强制失效（活动取消/强制完成/联合强制结束） */
  FORCE_INVALIDATED: 'FORCE_INVALIDATED',
} as const;

export type InvitationStatus = (typeof InvitationStatus)[keyof typeof InvitationStatus];

/** 终态（已接受为不可逆终态；其余为可重发的终态） */
export const TERMINAL_STATUSES: readonly InvitationStatus[] = [
  InvitationStatus.ACCEPTED,
  InvitationStatus.REJECTED,
  InvitationStatus.WITHDRAWN,
  InvitationStatus.EXPIRED,
  InvitationStatus.FORCE_INVALIDATED,
];

/** 转换非法异常（IFC-ERR-007 状态冲突 / IFC-ERR-006 前置失败） */
export class IllegalInvitationTransitionError extends Error {
  constructor(from: InvitationStatus, to: InvitationStatus) {
    super(`IFC-ERR-007: 非法邀请状态转换 ${from} -> ${to}`);
    this.name = 'IllegalInvitationTransitionError';
  }
}

/** 转换规则（SRS-SM-INV-001 7.1 明细；重发为创建新对象，不在此表） */
const TRANSITIONS: Readonly<Record<InvitationStatus, readonly InvitationStatus[]>> = {
  [InvitationStatus.NEW]: [InvitationStatus.PENDING],
  [InvitationStatus.PENDING]: [
    InvitationStatus.ACCEPTED,
    InvitationStatus.REJECTED,
    InvitationStatus.WITHDRAWN,
    InvitationStatus.EXPIRED,
    InvitationStatus.FORCE_INVALIDATED,
  ],
  // 已接受不可逆：无出边（REC-026、JNT-016）
  [InvitationStatus.ACCEPTED]: [],
  [InvitationStatus.REJECTED]: [],
  [InvitationStatus.WITHDRAWN]: [],
  [InvitationStatus.EXPIRED]: [],
  [InvitationStatus.FORCE_INVALIDATED]: [],
};

/** 邀请状态机（纯规则；SRS-SM-INV-001） */
export class InvitationStateMachine {
  canTransition(from: InvitationStatus, to: InvitationStatus): boolean {
    return TRANSITIONS[from].includes(to);
  }

  /** 执行转换；非法转换抛 IllegalInvitationTransitionError */
  transition(from: InvitationStatus, to: InvitationStatus): InvitationStatus {
    if (!this.canTransition(from, to)) {
      throw new IllegalInvitationTransitionError(from, to);
    }
    return to;
  }

  /** 已接受不可撤销/不可改回待处理（REC-026） */
  isTerminal(status: InvitationStatus): boolean {
    return TERMINAL_STATUSES.includes(status);
  }

  /** 可重发（已拒绝/已撤回/已过期/强制失效；已接受不可重发） */
  canReissue(status: InvitationStatus): boolean {
    return (
      status === InvitationStatus.REJECTED ||
      status === InvitationStatus.WITHDRAWN ||
      status === InvitationStatus.EXPIRED ||
      status === InvitationStatus.FORCE_INVALIDATED
    );
  }
}
