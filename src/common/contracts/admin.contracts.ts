/**
 * 平台管理（admin）HTTP 契约类型
 *
 * 端点事实基线：docs/specification/接口清单-HTTP端点-v1.0.md §15
 * 逻辑契约：IFC-GEN-004 平台特权作用域、IFC-CMD-003 高风险命令（重认证）、
 *            IFC-SM-004/005、SRS-SM-ORG-001/002
 *
 * 鉴权卡点：platform:club:manage / platform:config:manage / platform:delete:execute /
 *           platform:audit:view / platform:export:execute。
 */

import type { ApiListResponse } from './api-envelope';
import type { EmailConfigInput, EmailConfigView, NotificationKind, NotificationKillSwitchState } from './notifications.contracts';
import type { FormDetail, FormDesignerState, FormField, FormListItem } from './forms.contracts';

/* ============ 社团接入与治理 ============ */

export type ClubAccessStatus =
  | 'wizard_pending'
  | 'enabled'
  | 'suspended'
  | 'sync_abnormal_ro'
  | 'pending_rebind';

export interface ClubSyncEvent {
  id: string;
  kind: 'group_lost' | 'repair' | 'rebind' | 'disconnect' | 'reaccess' | 'suspend' | 'recover' | 'import';
  at: string;
  note: string;
}

export interface ClubWizardState {
  selectedGroupId: string | null;
  leaderGroupId: string | null;
  email: string | null;
  deptGroups: string[];
  roleGroups: string[];
  leaderRoleGroup: string | null;
}

/** GET /api/admin/clubs 响应 item */
export interface ClubAccessItem {
  clubId: string;
  clubName: string;
  description: string;
  status: ClubAccessStatus;
  groupId: string | null;
  groupName: string | null;
  mappingVersion: number;
  wizardStep: number;
  leaderName: string | null;
  memberCount: number;
  createdAt: string;
  boundAt: string | null;
  importedAt: string | null;
  importedCount: number;
  wizard: ClubWizardState | null;
  freezeExtensionMs: number;
  readonly: boolean;
  hasActiveBusiness: boolean;
  syncEvents: ClubSyncEvent[];
}

export interface CreateClubWizardInput {
  groupId: string;
  name: string;
  description?: string;
  leaderGroupId: string;
  email?: string;
  deptGroups?: string[];
  roleGroups?: string[];
  leaderRoleGroup?: string;
}

export interface WizardSaveStepInput {
  clubId: string;
  step?: number;
  selectedGroupId?: string;
  leaderGroupId?: string;
  email?: string;
  deptGroups?: string[];
  roleGroups?: string[];
  leaderRoleGroup?: string;
}

export interface WizardCompleteInput {
  clubId: string;
}

export interface ClubImportInput {
  memberIds: string[];
}

export interface ClubSuspendInput {
  reason: string;
}

export interface ClubRebindInput {
  groupId: string;
}

export interface ClubReaccessInput {
  groupId: string;
}

/* ============ Group 目录 ============ */

export interface AdminGroupItem {
  id: string;
  name: string;
  stableId: string;
  path: string;
  parentId: string | null;
  purpose: 'club' | string;
  boundClubId: string | null;
  memberCount: number;
}

export interface AdminGroupSearchItem extends AdminGroupItem {
  match: 'exact' | 'substring' | 'fuzzy';
  score: 1 | 0.8 | 0.6;
}

export interface AdminGroupSearchResult {
  items: AdminGroupSearchItem[];
  threshold: 3;
}

export interface AdminGroupDetail extends AdminGroupItem {
  members: Array<{ id: string; name: string }>;
  leaderGroups: string[];
  departments: string[];
  positions: string[];
}

/* ============ 权限模板 ============ */

export interface PermissionTemplateItem {
  id: string;
  name: string;
  permissions: string[];
  status: 'published' | 'draft';
  version: number;
  draftVersion: number | null;
}

export interface CreatePermissionTemplateInput {
  name: string;
  permissions: string[];
}

export interface CreatePermissionTemplateResult {
  id: string;
  name: string;
  permissions: string[];
  version: 0;
  draftVersion: 1;
  status: 'draft';
}

export interface SavePermissionTemplateInput {
  name: string;
  permissions: string[];
}

export interface SavePermissionTemplateResult {
  id: string;
  name: string;
  permissions: string[];
  status: 'draft';
  version: number;
  draftVersion: number;
  savedAt: string;
}

export interface PermissionTemplateDiff {
  added: string[];
  removed: string[];
  affectedGroups: string[];
  affectedMembers: number;
  previewVersion: number;
}

export interface PublishPermissionTemplateInput {
  reauthProof: string;
  previewVersion: number;
  reason: string;
}

export interface PublishPermissionTemplateResult {
  id: string;
  status: 'published';
  version: number;
  publishedAt: string;
  auditRef: string;
}

/* ============ 平台配置 ============ */

export interface PlatformConfig {
  clubName: string;
  clubDescription: string;
  requireEmailVerification: boolean;
  requireProfileComplete: boolean;
  maxMembers: number;
  allowSelfExit: boolean;
  academicYearStart: number;
}

export interface PlatformConfigSaved extends PlatformConfig {
  version: number;
  savedAt: string;
}

/* ============ 数据保留策略 ============ */

export interface RetentionPolicy {
  id: string;
  scope: string;
  retentionDays: number;
  action: 'auto_delete' | 'archive' | 'keep';
  status: 'active' | 'draft';
  version: number;
  updatedAt: string;
  publishedAt: string | null;
}

export interface RetentionView {
  policies: RetentionPolicy[];
  draftVersion: number | null;
  lastExecution: {
    runId: string;
    executedAt: string;
    results: unknown[];
  } | null;
}

export interface CreateRetentionInput {
  scope: string;
  retentionDays: number;
  action?: 'auto_delete' | 'archive' | 'keep';
}

export interface PublishRetentionInput {
  reason: string;
  reauthProof: string;
  previewVersion: number;
}

export interface PublishRetentionResult {
  id: string;
  scope: string;
  retentionDays: number;
  action: 'auto_delete' | 'archive' | 'keep';
  status: 'active';
  version: number;
  updatedAt: string;
  publishedAt: string;
  bufferDays: 7 | 0;
  notice: string | null;
  auditRef: string;
}

export interface RetentionPreview {
  scope: string;
  fromDays: number;
  toDays: number;
  action: 'auto_delete' | 'archive' | 'keep';
  affectedObjects: { records: number; members: number };
  bufferDays: number;
  previewVersion: number;
}

export interface ExecuteRetentionInput {
  reason: string;
  reauthProof: string;
}

export interface ExecuteRetentionResult {
  runId: string;
  executedAt: string;
  results: unknown[];
  totalExecuted: number;
  auditRef: string;
}

/* ============ 正式删除 ============ */

export interface DeletePreviewTarget {
  id: string;
  label: string;
  type: '社团' | '活动';
  recordCount: number;
  memberCount: number;
}

export interface DeletePreview {
  scope: 'club' | string;
  targets: DeletePreviewTarget[];
  totalRecords: number;
  totalMembers: number;
  warning: string;
  previewVersion: number;
}

export interface DeleteExecuteInput {
  targetIds: string[];
  reason: string;
  reauthProof: string;
  previewVersion: number;
}

export interface DeleteExecuteResult {
  results: Array<{ targetId: string; success: true; stores: string[] }>;
  completedAt: string;
  auditRef: string;
}

/* ============ 运维与统计 ============ */

export interface OpsStatus {
  appVersion: string;
  uptime: number;
  dependencies: Array<{ name: string; status: 'healthy' | 'degraded'; latency: number }>;
  taskQueue: { pending: number; processing: number; failed: number };
  lastCheckAt: string;
}

/* ============ 平台通知管理 ============ */

export type PlatformNotificationPreferences = Record<NotificationKind, boolean>;

/** GET /api/admin/notifications/templates 响应 item */
export interface AdminNotificationTemplate {
  kind: NotificationKind;
  title: string;
  body: string;
  emailSubject?: string;
  emailBody?: string;
  channel: ['inbox'] | ['inbox', 'email'];
  link: string | null;
  dedupKey: string | null;
}

export type AdminKillSwitchView = NotificationKillSwitchState;

/* ============ 平台表单（§13.2，与 org 版同构，无 clubId 维度） ============ */

export type AdminFormListItem = FormListItem & { scope: 'platform' };
export type AdminFormDetail = FormDetail;
export type AdminFormDesignerState = FormDesignerState;
export type AdminSaveFormDraftInput = {
  fields: FormField[];
  version?: number;
  expectedVersion?: number;
};

/* ============ 列表结果类型 ============ */

export type AdminClubListResult = ApiListResponse<ClubAccessItem>;
export type AdminGroupListResult = ApiListResponse<AdminGroupItem>;
export type AdminPermissionTemplateListResult = ApiListResponse<PermissionTemplateItem>;
export type AdminNotificationTemplateListResult = ApiListResponse<AdminNotificationTemplate>;
export type AdminFormListResult = ApiListResponse<AdminFormListItem>;

export type { EmailConfigInput, EmailConfigView };
