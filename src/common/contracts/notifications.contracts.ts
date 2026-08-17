/**
 * 通知域 HTTP 契约类型
 *
 * 端点事实基线：docs/specification/接口清单-HTTP端点-v1.0.md §7、§14.4
 * 逻辑契约：IFC-SM-027、IFC-TX-002/005、IFC-NTF-001
 */

/** 通知模板 kind 枚举（清单附录 B，8 类） */
export type NotificationKind =
  | 'application'
  | 'interview'
  | 'invitation'
  | 'conclusion'
  | 'system'
  | 'member'
  | 'transition'
  | 'correction';

/** GET /api/notifications 响应 item */
export interface NotificationItem {
  id: string;
  userId: string;
  type: NotificationKind;
  title: string;
  body: string;
  read: boolean;
  createdAt: string;
  link: string | null;
  clubName: string | null;
}

/** GET /api/notifications 响应 data */
export interface NotificationListResult {
  items: NotificationItem[];
  nextCursor: string | null;
}

/** GET /api/notifications/unread-count 响应 data */
export interface NotificationUnreadCount {
  count: number;
}

/** 通知偏好（按 kind 布尔；未知 kind 拒绝或登记，不得静默接受） */
export type NotificationPreferences = Record<NotificationKind, boolean>;

/** GET /api/me/notifications/preferences 响应 data */
export interface MeNotificationPreferencesResult {
  preferences: NotificationPreferences;
  savedAt: string | null;
}

/** POST /api/me/notifications/preferences 请求 input（部分 kind 可更新） */
export type MeNotificationPreferencesInput = Partial<NotificationPreferences>;

/** GET /api/org/:clubId/notifications/preferences 响应 data */
export interface OrgNotificationPreferencesResult {
  preferences: NotificationPreferences;
  savedAt: string | null;
}

/** POST /api/org/:clubId/notifications/preferences 请求 input（部分 kind 可更新） */
export type OrgNotificationPreferencesInput = Partial<NotificationPreferences>;

/** POST /api/org/:clubId/notifications/preferences 响应 data */
export interface OrgNotificationPreferencesSaved {
  preferences: NotificationPreferences;
  savedAt: string;
}

/** POST /api/me/notifications/preferences 响应 data */
export interface MeNotificationPreferencesSaved {
  preferences: NotificationPreferences;
  savedAt: string;
}

/** 通知熔断状态（GET/POST /api/org/:clubId/notifications/kill-switch） */
export interface NotificationKillSwitchState {
  active: boolean;
  scope: 'platform' | 'club' | null;
  clubId: string | null;
  reason: string;
  operatorName: string;
  stoppedAt: string;
  droppedCount: number;
}

/** POST /api/org/:clubId/notifications/kill-switch 请求 input */
export interface NotificationKillSwitchInput {
  active: boolean;
  reason?: string;
}

/** SMTP 配置（脱敏，不含密钥） */
export interface EmailConfigView {
  smtpHost: string;
  smtpPort: number;
  smtpUser: string;
  fromName: string;
  encryption: 'ssl' | 'tls' | 'none';
  verified: boolean;
  lastTestPassedAt: string | null;
  keyRotatedAt: string | null;
}

/** POST /api/org/:clubId/notifications/email-config 请求 input */
export interface EmailConfigInput {
  smtpHost: string;
  smtpPort?: number;
  smtpUser: string;
  fromName: string;
  encryption?: 'ssl' | 'tls' | 'none';
}

/** POST /api/org/:clubId/notifications/email-config 响应 data */
export interface EmailConfigSaved extends EmailConfigView {
  savedAt: string;
}

/** POST /api/org/:clubId/notifications/email-config/test 响应 data */
export interface EmailConfigTestResult {
  status: 'sent';
  sentAt: string;
  to: string;
}

/** POST /api/org/:clubId/notifications/email-config/rotate-key 响应 data */
export interface EmailKeyRotated {
  rotated: boolean;
  rotatedAt: string;
  verified: boolean;
}

/** 邮件发送记录（GET /api/admin/notifications/email-outbox） */
export interface EmailOutboxItem {
  id: string;
  toUserId: string;
  toEmail: string;
  subject: string;
  body: string;
  kind: NotificationKind;
  clubId: string | null;
  sentAt: string;
}

/** 通知模板目录 item（GET /api/admin/notifications/templates） */
export interface NotificationTemplate {
  kind: NotificationKind;
  title: string;
  body: string;
  emailSubject?: string;
  emailBody?: string;
  channel: ['inbox'] | ['inbox', 'email'];
  link: string | null;
  dedupKey: string | null;
}
