/**
 * 导出权限边界端口（5.4.2，EXP-003 / JNT-023 / GOV-004 / AUD-009）。
 *
 * 导出者按 5 类权限边界收敛，逐请求从当前登录用户重新解析 ExportPrincipal
 * （不信任前端角色/作用域，与 STATISTICS_AUTHORIZATION_PORT 口径一致）：
 * - club_leader_hr（社团负责人/人事）：可导出本社团统计/成员；
 * - department_leader（部门负责人）：可导出本部门成员 + 进入本部门招新路径的申请人，
 *   不得越出本部门作用域；
 * - interviewer（普通面试官）：禁止批量导出（仅个人"/"本人数据不可见时拒绝）；
 * - member_applicant（普通成员/申请人）：仅个人副本（本人报名表/附件/邀请/公开结果）；
 * - platform_super_admin（平台超管）：全平台或指定社团，须填写用途并产生特权审计，
 *   高风险用途须重新认证（IFC-ERR-002）与安全开关校验（IFC-ERR-011）。
 *
 * 审计：凡涉及越界/特权/拒绝的导出行为均须留痕可追踪（STAT-002 特权审计延伸）。
 */

// ---------------------------------------------------------------------------
// 导出者分类
// ---------------------------------------------------------------------------

export type ExportExporterKind =
  /** 社团负责人/人事：本社团导出 */
  | 'club_leader_hr'
  /** 部门负责人：本部门成员 + 进入本部门招新路径的申请人 */
  | 'department_leader'
  /** 普通面试官：禁止批量导出 */
  | 'interviewer'
  /** 普通成员/申请人：仅个人副本 */
  | 'member_applicant'
  /** 平台超管：全平台/指定社团，须用途 + 特权审计 */
  | 'platform_super_admin';

// ---------------------------------------------------------------------------
// 导出主体
// ---------------------------------------------------------------------------

/** 当前用户在某个社团的导出作用域 */
export interface ExportClubScope {
  readonly clubId: string;
  /** club = 全社团；department = 仅限本部门 */
  readonly level: 'club' | 'department';
  readonly departmentIds: readonly string[];
}

/** 导出主体（逐请求实时重算；不与统计主体混用） */
export interface ExportPrincipal {
  readonly userId: string;
  readonly kind: ExportExporterKind;
  readonly clubScopes: readonly ExportClubScope[];
}

// ---------------------------------------------------------------------------
// 安全开关（GOV-004）
// ---------------------------------------------------------------------------

export interface ExportSafetySwitchState {
  readonly allowed: boolean;
  readonly reason?: string;
}

// ---------------------------------------------------------------------------
// 审计
// ---------------------------------------------------------------------------

export type ExportAuditAction =
  | 'export_apply'
  | 'export_retry'
  | 'export_delete' // 申请人提前删除
  | 'export_formal_delete_invalidate' // 正式删除清单联动失效（AUD-009）
  | 'export_suspension_invalidate' // 参与社团紧急停用使链接失效（JNT-023）
  | 'export_expire' // 过期收敛（IFC-ERR-006）
  | 'export_download'
  | 'export_status';

export interface ExportAuditEntry {
  readonly at: string; // ISO
  readonly action: ExportAuditAction;
  readonly principalId: string;
  readonly privileged: boolean; // true → 超管特权，应标记特权审计
  readonly clubId: string | null;
  readonly jointActivityId: string | null;
  readonly datasetType: string | null;
  readonly exportId: string | null;
  readonly purpose: string | null;
  readonly outcome: 'allowed' | 'denied';
  readonly reason?: string;
}

// ---------------------------------------------------------------------------
// 端口接口
// ---------------------------------------------------------------------------

export interface ExportAuthorizationPort {
  /** 逐请求解析当前用户的导出主体（fail-closed：无身份不解析） */
  resolveExportPrincipal(userId: string): Promise<ExportPrincipal>;
}

export interface ExportAuditPort {
  /** 记录一次导出行为（允许/拒绝均记录，特权更须留痕） */
  record(entry: ExportAuditEntry): Promise<void>;
}

export interface ExportSafetySwitchPort {
  /** 导出安全开关（GOV-004；关闭 → IFC-ERR-011） */
  checkAllowed(): Promise<ExportSafetySwitchState>;
}

export interface ExportReauthPort {
  /** 用户最近一次高风险重新认证时间（IFC-ERR-002；超管用途导出须校验新鲜度） */
  latestReauthAt(userId: string): Promise<Date | null>;
}

// ---------------------------------------------------------------------------
// DI 令牌
// ---------------------------------------------------------------------------

export const EXPORT_AUTHORIZATION_PORT = Symbol('EXPORT_AUTHORIZATION_PORT');
export const EXPORT_AUDIT_PORT = Symbol('EXPORT_AUDIT_PORT');
export const EXPORT_SAFETY_SWITCH_PORT = Symbol('EXPORT_SAFETY_SWITCH_PORT');
export const EXPORT_REAUTH_PORT = Symbol('EXPORT_REAUTH_PORT');
