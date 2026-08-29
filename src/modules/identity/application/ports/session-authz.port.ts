/**
 * 会话授权视图端口（identity 应用层；A4 接线）。
 *
 * 与 application/queries/session-authz.query.ts 的 SessionAuthorizationQuery 同名
 * 概念——本文件定义端口契约，query 是它的默认适配实现（数据源由 organization
 * 模块 ORG_SESSION_AUTHZ_SOURCE 提供）。
 *
 * 组合点（session 装配 + /api/me/clubs）：nest 控制层
 * （interfaces/nest/casdoor-session.controller / account-access.nest.controller）
 * 调用查询；会话建立/刷新/GET /api/me/clubs 三路径复用同一结果。
 */

export interface SessionAuthzSnapshot {
  /** 平台超管身份（ORG-029：跨社团工作空间豁免，权限集独立于社团模板体系） */
  readonly platformSuperAdmin: boolean;
  /** 主体当前有效社团工作空间（含角色语义与权限集合） */
  readonly clubs: ReadonlyArray<{
    readonly clubId: string;
    readonly clubName: string;
    readonly role: 'club_leader' | 'hr' | 'department_leader' | 'member';
    readonly permissions: readonly string[];
  }>;
}

/** 会话授权源端口（identity 应用层契约；organization 模块适配实现）。 */
export interface SessionAuthzPort {
  describeForSubject(subjectId: string): Promise<SessionAuthzSnapshot>;
}
