/**
 * 站内信紧急关闭领域模型（NTF-001、SRS-FAIL-009、IFC-NTF-001、XCC-FAIL-009）。
 *
 * 超级管理员可按全平台或指定社团紧急关闭站内信：必须填写原因、
 * 二次确认并设置预计恢复时间，同时写入特权审计（需求发现 08）。
 *
 * 关闭只暂停对应渠道呈现/投递：通知事实与收件人快照仍保存，
 * 新事实标记为暂停投递；恢复后按原事件时间升序补投，并以
 * 逻辑事件＋收件人去重，不重复产生业务事件。
 */

/** 紧急关闭作用域 */
export type KillSwitchScope = 'PLATFORM' | 'CLUB';

/** 站内信紧急关闭状态 */
export interface KillSwitchStateModel {
  /** 关闭记录标识（UUIDv7） */
  readonly switchId: string;
  /** 关闭作用域：全平台或指定社团 */
  readonly scope: KillSwitchScope;
  /** 社团标识（scope=CLUB 时必填，否则为 null） */
  readonly clubId: string | null;
  /** 是否处于关闭状态 */
  readonly active: boolean;
  /** 关闭原因（必填） */
  readonly reason: string;
  /** 操作者主体标识 */
  readonly operatorId: string;
  /** 操作者展示名称 */
  readonly operatorName: string;
  /** 首次关闭时间（幂等保留首次 stoppedAt，重复关闭不覆盖） */
  readonly stoppedAt: string | null;
  /** 预计恢复时间（必填，恢复提醒依据） */
  readonly expectedRecoveryAt: string | null;
  /** 二次确认标记（关闭必须二次确认） */
  readonly confirmed: boolean;
  /** 特权审计引用 */
  readonly auditRef: string | null;
  /** 关闭期间拦截（暂停投递）的通知事实累计数 */
  readonly droppedCount: number;
  /** 版本号（乐观锁） */
  readonly version: number;
  /** 创建时间 */
  readonly createdAt: string;
  /** 最近更新时间 */
  readonly updatedAt: string;
}

/** 关闭/恢复站内信命令输入 */
export interface KillSwitchCommandInput {
  /** 关闭作用域 */
  readonly scope: KillSwitchScope;
  /** 社团标识（scope=CLUB 时必填） */
  readonly clubId: string | null;
  /** 关闭原因（关闭时必填） */
  readonly reason: string;
  /** 操作者主体标识 */
  readonly operatorId: string;
  /** 操作者展示名称 */
  readonly operatorName: string;
  /** 预计恢复时间（关闭时必填） */
  readonly expectedRecoveryAt: string | null;
  /** 二次确认标记（关闭时必须为 true） */
  readonly confirmed: boolean;
  /** 特权审计引用（可空，应用层生成后回填） */
  readonly auditRef?: string | null;
}

/**
 * 校验紧急关闭输入是否合法。
 * 返回 null 表示合法，否则返回拒绝原因。
 * 时间"必须晚于当前时间"由应用层以时钟校验，此处只做格式与范围一致性校验。
 */
export function validateKillSwitchCommandInput(input: KillSwitchCommandInput): string | null {
  if (input.scope !== 'PLATFORM' && input.scope !== 'CLUB') {
    return '关闭作用域必须为全平台或指定社团';
  }
  if (input.scope === 'CLUB' && !input.clubId) {
    return '指定社团关闭必须携带社团标识';
  }
  if (input.scope === 'PLATFORM' && input.clubId) {
    return '全平台关闭不得携带社团标识';
  }
  if (!input.reason || !input.reason.trim()) {
    return '必须填写关闭原因';
  }
  if (!input.expectedRecoveryAt) {
    return '必须设置预计恢复时间';
  }
  if (!Number.isFinite(Date.parse(input.expectedRecoveryAt))) {
    return '预计恢复时间必须为合法时间';
  }
  if (!input.confirmed) {
    return '必须二次确认后才可关闭站内信';
  }
  if (!input.operatorId) {
    return '操作者标识不能为空';
  }
  return null;
}
