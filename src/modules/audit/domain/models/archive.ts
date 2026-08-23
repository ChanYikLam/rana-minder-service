/**
 * 归档记录（AUD-004：招新/联合活动完成后自动进入只读归档，不要求额外归档操作）。
 */
export const ArchiveKind = {
  RECRUITMENT: 'RECRUITMENT',
  JOINT: 'JOINT',
} as const;

export type ArchiveKind = (typeof ArchiveKind)[keyof typeof ArchiveKind];

/** 参与关系锁定快照（联合归档：按**首次公布**锁定参与关系，JNT 规则） */
export interface LockedParticipant {
  readonly clubId: string;
  /** 该参与社团在首次公布时是否启用（停用社团停用期间不能查看） */
  readonly enabledAtLock: boolean;
}

/**
 * 归档记录（自动只读归档；AUD-004）。
 *
 * - 活动完成后自动归档，只读（readOnly 恒 true），不要求额外归档操作；
 * - 参与关系/社团启用状态在归档时锁定为快照，访问按**当前有效角色**重新鉴权；
 * - 历史负责人/部长/离任成员**不因过去职位保留访问权**。
 */
export interface ArchiveRecord {
  /** 活动 ID（招新/联合） */
  readonly activityId: string;
  readonly kind: ArchiveKind;
  readonly archivedAt: string;
  /** 参与社团列表（锁定快照） */
  readonly participants: readonly LockedParticipant[];
  /** 活动源状态（只读） */
  readonly sourceState: string;
  /** 恒为只读 */
  readonly readOnly: true;
  readonly version: number;
}
