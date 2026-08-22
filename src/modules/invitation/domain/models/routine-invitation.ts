import type { RoutineInvitationStatus } from '../state-machines/routine-invitation-state-machine';

/** 组合关系同步状态（MEM-018/ORG-027：社团及可选部门关系全部回读确认才成功） */
export const RelationSyncStatus = {
  /** 待确认（回读未完成） */
  PENDING: 'PENDING',
  /** 全部确认（社团 + 初始部门全部回读一致） */
  ALL_CONFIRMED: 'ALL_CONFIRMED',
  /** 部分确认（只确认部分关系 → 不得成功，按组合补偿） */
  PARTIAL: 'PARTIAL',
  /** 未确认（外部失败） */
  UNCONFIRMED: 'UNCONFIRMED',
  /** 无法确认且无法补偿到非成员（高优先级同步异常） */
  ANOMALY: 'ANOMALY',
} as const;

export type RelationSyncStatus = (typeof RelationSyncStatus)[keyof typeof RelationSyncStatus];

/** 组合关系项（社团 Group + 可选初始部门） */
export interface RelationTarget {
  readonly kind: 'GROUP' | 'DEPARTMENT';
  readonly refId: string;
  readonly confirmed: boolean;
}

/** 不可变历史 */
export interface RoutineHistoryEvent {
  readonly at: string;
  readonly type:
    | 'CREATED'
    | 'ACCEPTED'
    | 'REJECTED'
    | 'WITHDRAWN'
    | 'EXPIRED'
    | 'ACTIVATED'
    | 'TARGET_ALREADY_MEMBER'
    | 'SYNC_FAILED'
    | 'HIGH_PRIORITY_ANOMALY';
  readonly by: string;
  readonly note?: string;
}

/**
 * 常规入社邀请领域模型（SRS-SM-MEM-004）。
 *
 * 保存邀请内容、有效期、初始部门与组合关系同步状态；
 * 成员关系由 membership 模块拥有，本模型不推进成员经历（MEM-018）。
 */
export interface RoutineInvitation {
  readonly routineInvitationId: string;
  /** 目标账号（有效且尚非本社团成员） */
  readonly inviteeId: string;
  readonly clubId: string;
  readonly issuerId: string;
  /** 初始部门（零或一个且有效；null=不指定部门） */
  readonly initialDepartmentId: string | null;
  readonly status: RoutineInvitationStatus;
  readonly version: number;
  readonly createdAt: string;
  readonly expiresAt: string;
  /** 接受时间（整体接受；不可拆分） */
  readonly acceptedAt: string | null;
  /** 已生效时间（全部回读确认） */
  readonly activatedAt: string | null;
  /** 组合关系目标（社团 Group + 可选初始部门） */
  readonly relationTargets: readonly RelationTarget[];
  /** 组合关系同步状态 */
  readonly syncStatus: RelationSyncStatus | null;
  /** 已尝试次数（先回读后重试；无需本人重接） */
  readonly attemptCount: number;
  readonly lastError?: string;
  readonly history: readonly RoutineHistoryEvent[];
}
