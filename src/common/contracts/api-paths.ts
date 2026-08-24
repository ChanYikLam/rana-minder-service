/**
 * 传输层 API 路径常量
 *
 * 权威来源：docs/specification/接口实现规格-v1.0.md §6（API-EP-001/002）
 * 与 docs/specification/接口清单-HTTP端点-v1.0.md 各章节端点事实基线。
 *
 * 约束：
 * - 资源用 kebab-case 复数名词；对象标识用稳定 UUIDv7。
 * - 社团作用域经路径参数 :clubId 表达（客户端工作空间提示；服务端冻结）。
 * - 状态转换用“资源＋动作子资源”，动作必须对应登记过的逻辑操作。
 */

export const API_PREFIX = '/api';

export const API_AUTH = {
  session: '/api/auth/session',
  logout: '/api/auth/logout',
  profile: '/api/auth/profile',
  sendEmailCode: '/api/auth/profile/send-email-code',
  verifyEmail: '/api/auth/profile/verify-email',
  syncConflict: '/api/auth/profile/sync-conflict',
  reauth: '/api/auth/reauth',
  casdoorLoginUrl: '/api/auth/casdoor/login-url',
} as const;

export const API_ME = {
  clubs: '/api/me/clubs',
  todo: '/api/me/todo',
  ongoing: '/api/me/ongoing',
  history: '/api/me/history',
  schedule: '/api/me/schedule',
  notificationsPreferences: '/api/me/notifications/preferences',
  interviewTasks: '/api/me/interviews/tasks',
} as const;

export const API_NOTIFICATIONS = {
  list: '/api/notifications',
  unreadCount: '/api/notifications/unread-count',
  readAll: '/api/notifications/read-all',
} as const;

export const API_FILES = {
  upload: '/api/files/upload',
} as const;

export const API_EXPLORE = {
  clubs: '/api/explore/clubs',
  activities: '/api/explore/activities',
} as const;

/** 普通社团作用域路径构造；clubId 由服务端回源验证后冻结作用域 */
export const orgPath = {
  base: (clubId: string) => `/api/org/${clubId}`,
  context: (clubId: string) => `/api/org/${clubId}/context`,
  dashboard: (clubId: string) => `/api/org/${clubId}/dashboard`,
  members: (clubId: string) => `/api/org/${clubId}/members`,
  memberDetail: (clubId: string, memberId: string) => `/api/org/${clubId}/members/${memberId}`,
  recruitment: (clubId: string) => `/api/org/${clubId}/recruitment`,
  recruitmentDetail: (clubId: string, activityId: string) =>
    `/api/org/${clubId}/recruitment/${activityId}`,
  joint: (clubId: string) => `/api/org/${clubId}/joint`,
  jointDetail: (clubId: string, jointId: string) => `/api/org/${clubId}/joint/${jointId}`,
  forms: (clubId: string) => `/api/org/${clubId}/forms`,
  config: (clubId: string) => `/api/org/${clubId}/config`,
  stats: (clubId: string) => `/api/org/${clubId}/stats`,
  exports: (clubId: string) => `/api/org/${clubId}/exports`,
} as const;

/** 公开申请侧路径 */
export const activityPath = {
  recruitmentApply: (activityId: string) => `/api/activity/recruitment/${activityId}/apply`,
  recruitmentDraft: (activityId: string) => `/api/activity/recruitment/${activityId}/draft`,
  recruitmentWithdraw: (activityId: string) => `/api/activity/recruitment/${activityId}/withdraw`,
  jointApply: (jointId: string) => `/api/activity/joint/${jointId}/apply`,
  jointDraft: (jointId: string) => `/api/activity/joint/${jointId}/draft`,
  jointWithdraw: (jointId: string) => `/api/activity/joint/${jointId}/withdraw`,
} as const;

/** 平台特权路径统一置于 /api/admin/ 下 */
export const adminPath = {
  clubs: '/api/admin/clubs',
  groups: '/api/admin/groups',
  config: '/api/admin/config',
  retention: '/api/admin/retention',
  deletePreview: '/api/admin/delete/preview',
  deleteExecute: '/api/admin/delete/execute',
  opsStatus: '/api/admin/ops-status',
  stats: '/api/admin/stats',
} as const;
