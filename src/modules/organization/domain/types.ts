/**
 * 组织与授权模块 · 领域共享类型与错误（SRS-SM-ORG-001~004）。
 *
 * 权威来源：docs/requirements/03-社团组织与权限需求发现记录.md、
 * docs/specification/SRS-状态机转换明细-v1.0.md §4、SRS-v1.0.md §9。
 *
 * 本文件只冻结类型/常量，不承载可执行规则（规则在各 state-machines /
 * services 内，避免"类型即规则"导致的职责散落）。
 */

import { ErrorCode } from '../../../common/errors/error-code';

// --------------------------------------------------------------------------
// 稳定标识（ORG-013、DATA-OWN-*：名称/路径变化视为身份歧义，须经对账确认，
// 不得静默重绑；stableId 承载 owner+name 定位元组）
// --------------------------------------------------------------------------

/** Casdoor Group 稳定定位元组：owner + name 组合（ORG-013、CAS-MAP-003） */
export interface GroupStableRef {
  readonly owner: string;
  readonly name: string;
}

/** 本地内部稳定标识前缀约定（DATA-OWN-*；名称不参与关系筛选键） */
export const IdPrefix = {
  CLUB: 'club',
  MAPPING: 'gmap',
  RELATION_COMMAND: 'relcmd',
  APPOINTMENT_COMMAND: 'apptcmd',
  DEPARTMENT: 'dept',
  POSITION: 'pos',
  PERMISSION_TEMPLATE: 'ptpl',
  BATCH: 'batch',
  GROUP_EVENT: 'gev',
} as const;

export type IdPrefix = (typeof IdPrefix)[keyof typeof IdPrefix];

// --------------------------------------------------------------------------
// Group 用途（ORG-011/012/014/017/018：一个 Group 只能配置为社团/部门/职位之一）
// --------------------------------------------------------------------------

export type GroupPurpose = 'club' | 'department' | 'position';

// --------------------------------------------------------------------------
// ORG-001 社团接入状态机（SRS-SM-ORG-001）
// --------------------------------------------------------------------------

export type ClubStatus =
  | 'wizard_pending' // 向导未完成
  | 'enabled' // 已启用
  | 'suspended' // 已停用（可恢复；强制停用走 forcedSuspension 正交标志）
  | 'sync_abnormal_readonly' // 同步异常只读
  | 'pending_reaccess'; // 待重新接入（有历史时解除接入的目标）

// --------------------------------------------------------------------------
// ORG-002 Group 关系命令状态机（SRS-SM-ORG-002）
// --------------------------------------------------------------------------

export type RelationCommandStatus =
  | 'pending_execution' // 待执行
  | 'processing' // 处理中
  | 'processing_compensating' // 处理中（补偿中）
  | 'readback_confirmed' // 回读确认成功
  | 'failed_original_preserved' // 失败保持原状态
  | 'pending_manual_retry'; // 待人工重试

/** 关系命令类型（ORG-021/023/024/034；复合关系写入见 CAS-Q-001 方案 A） */
export type RelationCommandType =
  | 'join_club' // 加入社团
  | 'leave_club' // 退出社团
  | 'join_department' // 加入部门
  | 'leave_department' // 退出部门
  | 'appoint_position' // 任命职位
  | 'revoke_position' // 撤销职位
  | 'transfer_position'; // 调岗（复合：撤销旧职位 + 任命新职位）

/** 单一外部写入步骤（CAS-WR-*；每步独立幂等并关联同一业务命令） */
export interface RelationWriteStep {
  readonly stepId: string;
  readonly kind: 'add_member' | 'remove_member';
  readonly targetGroup: GroupStableRef;
  readonly subjectId: string;
  readonly idempotencyKey: string;
  /** 目标关系图允许按'基础/低权限 → 具体/高权限'排序（CAS-Q-001 方案 A） */
  readonly order: number;
  readonly result?: 'confirmed' | 'failed' | 'unknown' | 'compensated';
  readonly attemptCount: number;
  readonly lastError?: string;
}

// --------------------------------------------------------------------------
// ORG-003 预约管理命令状态机（SRS-SM-ORG-003）
// --------------------------------------------------------------------------

export type AppointmentCommandStatus =
  | 'created' // 新建
  | 'pending_execution' // 待执行
  | 'executing' // 执行中
  | 'effective' // 已生效
  | 'exec_failed_pending_retry' // 执行失败待重试
  | 'cancelled' // 已取消（不可恢复终态）
  | 'initiator_revoked_pending_reconfirm' // 发起人失权暂停待重新确认
  | 'precondition_invalid_pending_resolution' // 业务前置条件失效暂停待处置
  | 'reconfirmed_pending_execution'; // 已重新确认待执行

export type AppointmentCommandType =
  | 'appoint' // 预约任命
  | 'revoke' // 预约免职
  | 'transfer'; // 预约调岗

// --------------------------------------------------------------------------
// ORG-004 受控批量操作状态机（SRS-SM-ORG-004；属平台模块，本模块仅承载骨架）
// --------------------------------------------------------------------------

export type ControlledBatchStatus =
  | 'selecting' // 选择中
  | 'previewed_pending_confirm' // 已预览待确认
  | 'executing' // 执行中
  | 'all_succeeded' // 全部成功
  | 'partial_success' // 部分成功
  | 'all_failed' // 全部失败
  | 'failed_items_retrying'; // 失败项重试中

// --------------------------------------------------------------------------
// 错误
// --------------------------------------------------------------------------

/** ORG 领域错误：携带接口契约错误码（IFC-ERR-*），跨层可判读。 */
export class OrgDomainError extends Error {
  readonly code: ErrorCode;
  readonly detail: string;

  constructor(code: ErrorCode, message: string, detail = '') {
    super(message);
    this.name = 'OrgDomainError';
    this.code = code;
    this.detail = detail;
  }
}

/** 便捷构造（保持 code 语义与接口契约一致）。 */
export const orgError = {
  validation(message: string): OrgDomainError {
    return new OrgDomainError(ErrorCode.VALIDATION_FAILED, message);
  },
  forbidden(message: string): OrgDomainError {
    return new OrgDomainError(ErrorCode.FORBIDDEN, message);
  },
  notVisible(message: string): OrgDomainError {
    return new OrgDomainError(ErrorCode.NOT_VISIBLE, message);
  },
  precondition(message: string, detail = ''): OrgDomainError {
    return new OrgDomainError(ErrorCode.PRECONDITION_FAILED, message, detail);
  },
  stateConflict(message: string): OrgDomainError {
    return new OrgDomainError(ErrorCode.STATE_CONFLICT, message);
  },
  versionConflict(message: string): OrgDomainError {
    return new OrgDomainError(ErrorCode.VERSION_CONFLICT, message);
  },
  reauth(message: string): OrgDomainError {
    return new OrgDomainError(ErrorCode.REAUTH_REQUIRED, message);
  },
  externalUnknown(message: string): OrgDomainError {
    return new OrgDomainError(ErrorCode.EXTERNAL_UNKNOWN, message);
  },
  scopeMismatch(message: string): OrgDomainError {
    return new OrgDomainError(ErrorCode.SCOPE_MISMATCH, message);
  },
  commitFailed(message: string): OrgDomainError {
    return new OrgDomainError(ErrorCode.COMMIT_FAILED, message);
  },
};
