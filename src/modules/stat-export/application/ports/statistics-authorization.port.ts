/**
 * 统计主体与审计端口（STAT-002）。
 *
 * 主体解析：逐请求从当前登录用户重新解析 StatisticsPrincipal（逐请求重算权限，
 * 不信任前端角色/作用域；ORG-038 口径与组织模块一致）。
 *
 * 审计：全局与精确统计访问行为必须可追踪（STAT-002 特权审计）。
 */

// ---------------------------------------------------------------------------
// 统计主体
// ---------------------------------------------------------------------------

/** 当前用户在某个社团的统计作用域 */
export interface StatisticsClubScope {
  readonly clubId: string;
  /** club = 全社团；department = 仅限本部门 */
  readonly level: 'club' | 'department';
  readonly departmentIds: readonly string[];
}

/** 统计主体（实时重算） */
export interface StatisticsPrincipal {
  readonly userId: string;
  readonly isPlatformSuperAdmin: boolean;
  readonly clubScopes: readonly StatisticsClubScope[];
}

// ---------------------------------------------------------------------------
// 审计
// ---------------------------------------------------------------------------

export type StatisticsAccessAction =
  | 'club_summary'
  | 'club_drilldown'
  | 'recruitment_funnel'
  | 'joint_activity_stats'
  | 'platform_summary';

/** 统计审计条目 */
export interface StatisticsAccessAuditEntry {
  readonly at: string; // ISO
  readonly action: StatisticsAccessAction;
  readonly principalId: string;
  readonly privileged: boolean;
  readonly clubId: string | null;
  readonly jointActivityId: string | null;
  readonly outcome: 'allowed' | 'denied';
  readonly reason?: string;
}

// ---------------------------------------------------------------------------
// 端口接口
// ---------------------------------------------------------------------------

export interface StatisticsAuthorizationPort {
  /** 逐请求解析当前用户的统计主体（STAT-002） */
  resolvePrincipal(userId: string): Promise<StatisticsPrincipal>;
}

export interface StatisticsAuditPort {
  /** 记录一次统计访问（允许/拒绝均记录，留痕可追踪） */
  record(entry: StatisticsAccessAuditEntry): Promise<void>;
}

// ---------------------------------------------------------------------------
// DI 令牌
// ---------------------------------------------------------------------------

export const STATISTICS_AUTHORIZATION_PORT = Symbol('STATISTICS_AUTHORIZATION_PORT');
export const STATISTICS_AUDIT_PORT = Symbol('STATISTICS_AUDIT_PORT');
