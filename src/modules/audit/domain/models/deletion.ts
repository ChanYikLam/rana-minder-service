/**
 * 正式删除与临时清理领域模型（AUD-005~010）。
 */

/** 删除范围（超管正式删除：AUD-005/008） */
export const DeletionScopeKind = {
  /** 单条记录 */
  SINGLE_RECORD: 'SINGLE_RECORD',
  /** 某活动范围 */
  ACTIVITY: 'ACTIVITY',
  /** 某用户全部本地业务数据 */
  USER_ALL_DATA: 'USER_ALL_DATA',
} as const;

export type DeletionScopeKind = (typeof DeletionScopeKind)[keyof typeof DeletionScopeKind];

export interface DeletionScope {
  readonly kind: DeletionScopeKind;
  /** 对象定位（单条：objectType+objectId；活动：activityId；用户：principalId） */
  readonly objectType?: string;
  readonly objectId?: string;
  readonly activityId?: string;
  readonly principalId?: string;
}

/** 删除清单步骤（IFC-TX-007/AUD-009：跨存储逐项执行并回读核验） */
export const DeletionStepKind = {
  ONLINE_DB: 'ONLINE_DB',
  ATTACHMENT_STORE: 'ATTACHMENT_STORE',
  CACHE: 'CACHE',
  SEARCH_INDEX: 'SEARCH_INDEX',
  UNEXPIRED_EXPORT: 'UNEXPIRED_EXPORT',
} as const;

export type DeletionStepKind = (typeof DeletionStepKind)[keyof typeof DeletionStepKind];

export const DeletionStepStatus = {
  PENDING: 'PENDING',
  VERIFIED_DELETED: 'VERIFIED_DELETED',
  FAILED: 'FAILED',
} as const;

export type DeletionStepStatus = (typeof DeletionStepStatus)[keyof typeof DeletionStepStatus];

export interface DeletionStep {
  readonly stepId: string;
  readonly kind: DeletionStepKind;
  readonly targetRef: string;
  readonly status: DeletionStepStatus;
  /** 该步骤失败重试次数（幂等执行：每次失败 +1，成功归零；
   *  超出上限标记需人工介入，防无限重试空转） */
  readonly retryCount: number;
}

/**
 * 删除步骤最大失败重试次数（AUD-009 评审：防 FAILED 步骤无限重试）。
 * 达到上限后步骤保持未完成并标记需人工介入，由接线层告警收敛。
 */
export const MAX_STEP_RETRY_COUNT = 5;

/**
 * 恢复重放最大次数（AUD-009 评审：防备份恢复后无限重放累积）。
 * 超出后拒绝再次重放，由运维介入评估恢复必要性。
 */
export const MAX_REPLAY_COUNT = 10;

/**
 * 删除执行清单（IFC-TX-007、AUD-009）。
 *
 * - 独立持久化；历史备份恢复后**重新应用清单防复现**；
 * - 部分失败不得宣称完成（保持未完成，持续重试）。
 */
export interface DeletionChecklist {
  readonly checklistId: string;
  readonly scope: DeletionScope;
  /** 删除原因（超管必填；AUD-005） */
  readonly reason: string;
  /** 结构化删除用途（I1 白名单；随清单落库供合规追溯） */
  readonly purpose: string;
  readonly initiatedBy: string;
  readonly initiatedAt: string;
  /** 二次确认（展示受影响对象清单后确认；AUD-005/009） */
  readonly confirmed: boolean;
  /** 受影响对象清单（展示/预览；AUD-005） */
  readonly affectedObjects: readonly string[];
  /** 业务关系已结束（成员关系/有效邀请/进行中活动；AUD-008） */
  readonly businessRelationsEnded: boolean;
  readonly steps: readonly DeletionStep[];
  /** 全部核验删除 → 完成；部分失败保持未完成 */
  readonly completed: boolean;
  /** 恢复后重放次数（防复现） */
  readonly replayCount: number;
  /** 乐观锁版本（并发执行防护：同一清单只一个执行提交成功） */
  readonly version: number;
  /** 删除执行结果是否已落审计（审计写入成功；false=审计缺失，普通重试可补写） */
  readonly auditCommitted: boolean;
}

/**
 * 删除最小审计（AUD-006/008）。
 *
 * 删除后只保留内部记录标识、执行时间、执行超管和删除类型；
 * **不保留姓名/报名内容/评价/附件正文**。
 */
export interface MinimalDeletionAudit {
  readonly internalRecordId: string;
  readonly deletedAt: string;
  readonly performedBy: string;
  readonly deletionType: DeletionScopeKind;
  /** 不自动删 Casdoor 账号/Group/Claims，不能召回已发邮件（AUD-006/008） */
  readonly note: 'minimal-audit-only';
}

/** 临时清理项（AUD-007/009：未提交草稿/扫描失败/无有效引用上传/临时导出） */
export const TemporaryItemKind = {
  UNSUBMITTED_DRAFT: 'UNSUBMITTED_DRAFT',
  SCAN_FAILED: 'SCAN_FAILED',
  NO_REFERENCE_UPLOAD: 'NO_REFERENCE_UPLOAD',
  TEMPORARY_EXPORT: 'TEMPORARY_EXPORT',
} as const;

export type TemporaryItemKind = (typeof TemporaryItemKind)[keyof typeof TemporaryItemKind];

export interface TemporaryItem {
  readonly itemId: string;
  readonly kind: TemporaryItemKind;
  /** 期限（超管配置）已到（调用方判定） */
  readonly retentionExpired: boolean;
  /** 清理前重查引用：无有效引用才可清理 */
  readonly hasValidReference: boolean;
}
