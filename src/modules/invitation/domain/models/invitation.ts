import type { InvitationStatus } from '../state-machines/invitation-state-machine';

/** 邀请强类型（SRS-SM-INV-001：普通/联合邀请是不同强类型对象，不得混批或互相改型） */
export const InvitationKind = {
  /** 普通录取邀请（REC-024、REC-045） */
  RECRUIT_OFFER: 'RECRUIT_OFFER',
  /** 联合录取邀请（JNT-013~015） */
  JOINT_OFFER: 'JOINT_OFFER',
  /** 联合加入邀请（仅服从联合调剂时，JNT-014、JNT-027） */
  JOINT_JOIN: 'JOINT_JOIN',
} as const;

export type InvitationKind = (typeof InvitationKind)[keyof typeof InvitationKind];

/** 成员身份生效意图状态（REC-026/ORG-027：Casdoor 写后定向读回确认前不开放权限） */
export const ActivationStatus = {
  /** 成员身份生效处理中（页面显示；不得开放成员权限） */
  PROCESSING: 'PROCESSING',
  /** 已生效（Casdoor 回读确认完成） */
  ACTIVATED: 'ACTIVATED',
  /** 同步失败待重试（15 分钟内失败；保持已接受、成员未生效、通知） */
  SYNC_FAILED_PENDING_RETRY: 'SYNC_FAILED_PENDING_RETRY',
} as const;

export type ActivationStatus = (typeof ActivationStatus)[keyof typeof ActivationStatus];

/** 不可变历史（接受和退出历史不得删除；REC-026~028、JNT-016） */
export interface InvitationHistoryEvent {
  readonly at: string;
  readonly type:
    'CREATED' | 'ACCEPTED' | 'REJECTED' | 'WITHDRAWN' | 'EXPIRED' | 'FORCE_INVALIDATED';
  readonly by: string;
  readonly note?: string;
}

/**
 * 邀请领域模型（普通录取邀请；SRS-SM-INV-001）。
 *
 * 保存不可变邀请内容、有效期、结论关联与接受事实；
 * 成员身份生效由激活意图承接（本模型不直接推进成员关系，MEM-018）。
 */
export interface Invitation {
  readonly invitationId: string;
  readonly kind: InvitationKind;
  /** 指定本人（邀请对象） */
  readonly inviteeId: string;
  /** 发出社团 */
  readonly clubId: string;
  /** 发出方（负责人/人事；记录操作者） */
  readonly issuerId: string;
  /** 结论关联（已复核部门录取决定；REC-045） */
  readonly decisionRef: string | null;
  /**
   * 重发来源（REC-024）：若为重发产生的新邀请，记录被重发的旧邀请 id（强引用）。
   * 与 history 中的 `reissue-of:` note 弱关联不同，此字段建立可查询的强引用，
   * 便于追溯“同一录取对象的重发链”；普通首次创建为 null。
   */
  readonly reissuedFromId: string | null;
  /** 当前状态 */
  readonly status: InvitationStatus;
  /** 版本（单胜者竞争：接受/撤回/过期比较并交换） */
  readonly version: number;
  /** 有效期 */
  readonly createdAt: string;
  readonly expiresAt: string;
  /** 接受时间（= 成员业务生效时间；REC-026） */
  readonly acceptedAt: string | null;
  /** 成员身份生效意图（接受后创建；回读确认前 PROCESSING） */
  readonly activation: MemberActivationIntention | null;
  /** 不可变历史（不得删除） */
  readonly history: readonly InvitationHistoryEvent[];
}

/** 成员身份生效意图（接受后同事务创建；Casdoor 写后定向读回确认） */
export interface MemberActivationIntention {
  readonly intentionId: string;
  readonly invitationId: string;
  /** 成员业务生效时间（= 接受时间；REC-026） */
  readonly memberEffectiveAt: string;
  /** Casdoor 写入/回读状态（ORG-027：未回读确认前不开放权限） */
  readonly status: ActivationStatus;
  /** 已尝试次数（先回读后重试，无需本人再次接受） */
  readonly attemptCount: number;
  /** 失败原因（技术性，脱敏） */
  readonly lastError?: string;
  /** 最近一次尝试时间 */
  readonly lastAttemptAt?: string;
}
