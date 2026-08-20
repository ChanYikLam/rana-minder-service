/**
 * 查询：工作空间上下文（§4 GET /api/org/:clubId/context、dashboard）。
 *
 * 语义（ORG-038/040）：
 * - 管理工作台（ORG-040）进入前须选定当前有权社团；页头醒目显示当前社团；
 *   切换不改变关系。
 * - 全局个人空间（IDN-022）不要求先选社团——本查询仅承载"当前社团工作空间"，
 *   个人中心查询由个人中心投影承担。
 * - 逐请求按服务端当前权限重算，不信任前端角色/作用域（ORG-038）。
 */

import { orgError } from '../../domain/types';
import {
  CLUB_STORE,
  CURRENT_PERMISSIONS_PORT,
  ORG_CONTEXT_QUERY,
  type ClubStore,
  type CurrentPermissionsPort,
} from '../ports';

export interface OrgContextView {
  clubId: string;
  clubName: string;
  role: string;
  permissions: string[];
  memberId: string | null;
  readonly: boolean;
  forcedSuspension: boolean;
}

export interface OrgDashboardView {
  club: { id: string; name: string };
  role: string;
  permissions: string[];
  readonly: boolean;
  metrics: {
    pendingReviews: number;
    pendingInterviews: number;
    pendingResults: number;
    syncErrors: number;
  };
  todos: Array<{
    id: string;
    type: 'application_review' | 'interview_schedule' | 'invitation_pending';
    title: string;
    count: number;
  }>;
}

export class OrgContextQuery {
  constructor(
    private readonly clubs: ClubStore,
    private readonly permissions: CurrentPermissionsPort,
  ) {}

  async context(userId: string, clubId: string): Promise<OrgContextView> {
    const club = await this.clubs.findById(clubId);
    if (club === null) throw orgError.notVisible(`社团空间不存在（${clubId}）`);
    const perms = await this.permissions.effectiveForClub(userId, clubId);
    if (perms.length === 0) {
      throw orgError.forbidden(`用户 ${userId} 无权访问社团「${club.name}」工作空间（ORG-038）`);
    }
    return {
      clubId: club.id,
      clubName: club.name,
      role: resolveRoleLabel(perms),
      permissions: [...perms],
      memberId: null,
      readonly: club.readonly,
      forcedSuspension: club.forcedSuspension,
    };
  }

  async dashboard(userId: string, clubId: string): Promise<OrgDashboardView> {
    const ctx = await this.context(userId, clubId);
    if (ctx.readonly) {
      return {
        club: { id: ctx.clubId, name: ctx.clubName },
        role: ctx.role,
        permissions: ctx.permissions,
        readonly: true,
        metrics: { pendingReviews: 0, pendingInterviews: 0, pendingResults: 0, syncErrors: 0 },
        todos: [],
      };
    }
    // 骨架：聚合待办/指标由各领域模块投影提供，这里保持零值形状
    return {
      club: { id: ctx.clubId, name: ctx.clubName },
      role: ctx.role,
      permissions: ctx.permissions,
      readonly: false,
      metrics: {
        pendingReviews: 0,
        pendingInterviews: 0,
        pendingResults: 0,
        syncErrors: clubSyncErrors(ctx),
      },
      todos: [],
    };
  }
}

function resolveRoleLabel(perms: readonly string[]): string {
  if (perms.includes('platform:club:manage')) return 'super_admin';
  if (perms.includes('club:transition:manage') && perms.includes('club:config:manage'))
    return 'leader';
  if (perms.includes('club:member:manage:full')) return 'leader';
  if (perms.includes('club:appointment:manage')) return 'personnel';
  if (perms.includes('club:member:manage')) return 'department_head';
  return 'member';
}

function clubSyncErrors(ctx: OrgContextView): number {
  return ctx.forcedSuspension ? 1 : 0;
}

export const orgContextQueryProvider = {
  provide: ORG_CONTEXT_QUERY,
  useFactory: (clubs: ClubStore, permissions: CurrentPermissionsPort) =>
    new OrgContextQuery(clubs, permissions),
  inject: [CLUB_STORE, CURRENT_PERMISSIONS_PORT],
};
