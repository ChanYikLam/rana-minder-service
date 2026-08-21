/**
 * 社团邮件策略与用户偏好领域模型（NTF-004；需求发现 08「邮件默认开启、关闭和用户偏好」）。
 *
 * 规则（产品行为已冻结）：
 * - 所有允许使用邮件的学生权益通知默认开启邮件；
 * - 社团负责人和人事管理员可按活动或通知类型关闭本社团邮件；
 * - 人工发布时有权操作者可取消本次邮件，自动通知使用活动配置；
 * - 超级管理员可统一停用某类邮件（平台级 kind 停用，优先级最高）；
 * - 学生可以关闭普通业务邮件，但不能关闭邮箱验证、邮箱变更和安全通知；
 * - 未验证邮箱、用户关闭普通邮件或社团没有有效发信密钥时，
 *   只保存通知事实并按可用状态投递站内信。
 */

import type { NotificationKind } from '../../../../common/contracts/notifications.contracts';

/**
 * 受保护邮件类别（学生不可关闭；NTF-004）。
 * 邮箱验证、邮箱变更与安全通知不属于 8 类普通业务通知，
 * 不参与偏好开关，任何输入试图关闭一律拒绝。
 */
export const PROTECTED_EMAIL_CATEGORIES = [
  'email_verification',
  'email_change',
  'security',
] as const;

export type ProtectedEmailCategory = (typeof PROTECTED_EMAIL_CATEGORIES)[number];

/** 社团邮件策略（按 kind 与活动的开关；默认全部开启） */
export interface ClubEmailPolicy {
  readonly clubId: string;
  /** 按通知类型的邮件开关（未登记的 kind 视为默认开启） */
  readonly kindEmailEnabled: Partial<Record<NotificationKind, boolean>>;
  /** 按活动的邮件开关（活动粒度覆盖 kind 粒度） */
  readonly activityEmailEnabled: Record<string, boolean>;
  /** 最近更新人 */
  readonly updatedBy: string | null;
  /** 最近更新时间 */
  readonly updatedAt: string | null;
}

/** 平台级邮件停用目录（超管统一停用某类邮件；NTF-004.3） */
export type PlatformEmailSuspension = Partial<Record<NotificationKind, boolean>>;

/** 创建空策略：默认开启（NTF-004.1） */
export function defaultClubEmailPolicy(clubId: string): ClubEmailPolicy {
  return {
    clubId,
    kindEmailEnabled: {},
    activityEmailEnabled: {},
    updatedBy: null,
    updatedAt: null,
  };
}

/**
 * 解析某事件是否允许发邮件（社团维度；NTF-004）。
 * 优先级：活动覆盖 > 类型覆盖 > 默认开启。
 */
export function resolveClubEmailEnabled(
  policy: ClubEmailPolicy | null,
  kind: NotificationKind,
  activityId: string | null,
): boolean {
  if (!policy) return true; // 默认开启
  if (activityId && activityId in policy.activityEmailEnabled) {
    return policy.activityEmailEnabled[activityId];
  }
  const kindOverride = policy.kindEmailEnabled[kind];
  if (kindOverride !== undefined) return kindOverride;
  return true;
}

/** 用户邮件偏好（普通业务邮件按 kind 开关；受保护类别不在此模型内） */
export type UserEmailPreferences = Partial<Record<NotificationKind, boolean>>;

/** 用户邮件偏好解析：未登记视为开启（NTF-004.1 默认开启） */
export function resolveUserEmailEnabled(
  preferences: UserEmailPreferences | null,
  kind: NotificationKind,
): boolean {
  const value = preferences?.[kind];
  return value === undefined ? true : value;
}

/**
 * 校验偏好更新输入（NTF-004.4）。
 * 返回 null 表示合法；否则返回拒绝原因。
 * - 试图关闭受保护类别（邮箱验证/邮箱变更/安全）→ 拒绝；
 * - 未知 kind 键 → 拒绝（不得静默接受）。
 */
export function validateEmailPreferenceUpdate(input: Record<string, unknown>): string | null {
  const knownKinds = new Set<string>([
    'application',
    'interview',
    'invitation',
    'conclusion',
    'system',
    'member',
    'transition',
    'correction',
  ]);
  for (const [key, value] of Object.entries(input)) {
    if (PROTECTED_EMAIL_CATEGORIES.includes(key as ProtectedEmailCategory)) {
      return '邮箱验证、邮箱变更与安全通知不可关闭';
    }
    if (!knownKinds.has(key)) {
      return '未知通知类型: ' + key;
    }
    if (typeof value !== 'boolean') {
      return '偏好值必须为布尔: ' + key;
    }
  }
  return null;
}
