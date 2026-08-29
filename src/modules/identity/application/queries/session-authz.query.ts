/**
 * 会话授权查询（A4 接线；identity 应用层）。
 *
 * 数据源 SessionAuthzPort 定义于同目录 ports/session-authz.port.ts（identity 内部
 * 契约）；organization 模块的 ORG_SESSION_AUTHZ_SOURCE 在 identity.module.ts 经
 * 一个轻量适配器（identity.module.ts 中的 factory）转为该端口。identity 自身不
 * 依赖 organization 模块内部符号，可独立单元测试。
 *
 * 视图语义：
 * - 超管：会话 permissions = PLATFORM_SUPER_ADMIN_SESSION_PERMISSIONS，workspace = null
 *   （跨社团工作空间豁免；前端 hasPermission('platform:*') 路由到 /admin/clubs）；
 * - 普通主体：按 club_leader > hr > department_leader > member 优先级选主社团作为
 *   workspace（前端登录落点 /org/:clubId/dashboard 与资料门逻辑复用同一规则）；
 *   主体不在任何社团 → workspace = null、permissions = []（fail-closed，不混用超管权限）。
 */

import type { SessionAuthzPort, SessionAuthzSnapshot } from '../ports/session-authz.port';

export type SessionClubRole = 'club_leader' | 'hr' | 'department_leader' | 'member';

export interface SessionAuthorisationView {
  /** 会话顶层 permissions：超管时为平台权限集；普通主体时为 workspace 社团权限集 */
  readonly permissions: readonly string[];
  /** 当前工作空间（主社团）：无社团归属返回 null */
  readonly workspace: {
    readonly clubId: string;
    readonly clubName: string;
    readonly role: SessionClubRole;
    readonly permissions: readonly string[];
  } | null;
  /** 主体所有有效社团工作空间（GET /api/me/clubs 数据源） */
  readonly clubs: ReadonlyArray<{
    readonly clubId: string;
    readonly clubName: string;
    readonly role: SessionClubRole;
    readonly permissions: readonly string[];
  }>;
  /** 平台超管标记（供 controller 按需附加其它权限场景） */
  readonly platformSuperAdmin: boolean;
}

const ROLE_PRIORITY: Readonly<Record<SessionClubRole, number>> = {
  club_leader: 0,
  hr: 1,
  department_leader: 2,
  member: 3,
};

/**
 * 会话授权视图查询。
 *
 * 端口未装配时（测试 / 组织域未提供）返回零权限 + 空 clubs + 非超管——
 * 即 fail-closed：会话仅含公开页面与本人资料读权限。
 */
export class SessionAuthorizationQuery {
  constructor(private readonly port: SessionAuthzPort | undefined) {}

  async describe(subjectId: string): Promise<SessionAuthorisationView> {
    const snapshot: SessionAuthzSnapshot =
      this.port === undefined
        ? { platformSuperAdmin: false, clubs: [] }
        : await this.port.describeForSubject(subjectId);
    return toView(snapshot);
  }
}

export function toView(snapshot: SessionAuthzSnapshot): SessionAuthorisationView {
  if (snapshot.platformSuperAdmin) {
    return {
      permissions: [...PLATFORM_SUPER_ADMIN_PERMISSIONS],
      workspace: null,
      clubs: [],
      platformSuperAdmin: true,
    };
  }
  if (snapshot.clubs.length === 0) {
    return { permissions: [], workspace: null, clubs: [], platformSuperAdmin: false };
  }
  const sortedClubs = [...snapshot.clubs].sort(
    (a, b) => ROLE_PRIORITY[a.role] - ROLE_PRIORITY[b.role] || a.clubId.localeCompare(b.clubId),
  );
  const primary = sortedClubs[0]!;
  return {
    permissions: [...primary.permissions],
    workspace: {
      clubId: primary.clubId,
      clubName: primary.clubName,
      role: primary.role,
      permissions: [...primary.permissions],
    },
    clubs: sortedClubs,
    platformSuperAdmin: false,
  };
}

/** 平台超管会话层权限集（与 PermissionCatalog 平台位一致；本文件内复刻避免跨模块依赖） */
const PLATFORM_SUPER_ADMIN_PERMISSIONS = [
  'platform:club:manage',
  'platform:config:manage',
  'platform:delete:execute',
  'platform:export:execute',
  'platform:audit:view',
] as const;
