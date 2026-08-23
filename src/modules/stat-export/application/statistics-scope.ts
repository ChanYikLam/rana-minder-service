/**
 * 统计作用域收敛函数（STAT-002）。
 *
 * 在查询入口将实时解析的 StatisticsPrincipal 收敛到指定社团/联合活动的
 * 有效作用域。调用方（查询用例）据此约束回源事实和输出。
 *
 * 收敛规则（STAT-002）：
 * - 超级管理员：全社团范围（特权审计标记）；
 * - 社团负责人/人事管理员：本社团全范围（club level）；
 * - 部门负责人：本部门范围（departmentIds 约束）；
 * - 普通成员/申请人：无作用域 → 拒绝访问。
 */

import type { StatisticsPrincipal } from './ports/statistics-authorization.port';
import { statisticsErrors } from './statistics-errors';
import type { StatisticsSourcePort } from './ports/statistics-source.port';

// ---------------------------------------------------------------------------
// 社团作用域收敛
// ---------------------------------------------------------------------------

export interface ConvergedClubScope {
  readonly kind: 'club' | 'department';
  readonly departmentIds: readonly string[];
  readonly privileged: boolean; // true → 超管访问，应记录特权审计
}

/**
 * 收敛 principal 对指定 clubId 的统计作用域。
 * 返回 null 表示无权限（调用方需抛出 forbidden）。
 * 调用方还需单独检查社团停用状态（forcedSuspension 拒绝）。
 */
export function convergeClubScope(
  principal: StatisticsPrincipal,
  clubId: string,
): ConvergedClubScope | null {
  // 超管：全范围
  if (principal.isPlatformSuperAdmin) {
    return { kind: 'club', departmentIds: [], privileged: true };
  }

  const match = principal.clubScopes.find((s) => s.clubId === clubId);
  if (match === undefined) return null;

  return {
    kind: match.level,
    departmentIds: match.level === 'department' ? match.departmentIds : [],
    privileged: false,
  };
}

/**
 * 收敛并断言：无权限时抛出 forbidden。
 */
export function requireClubScope(
  principal: StatisticsPrincipal,
  clubId: string,
): ConvergedClubScope {
  const scope = convergeClubScope(principal, clubId);
  if (scope === null) {
    throw statisticsErrors.forbidden(
      `用户 ${principal.userId} 无权查看社团 ${clubId} 管理统计（STAT-002）`,
    );
  }
  return scope;
}

// ---------------------------------------------------------------------------
// 联合活动作用域收敛
// ---------------------------------------------------------------------------

export interface ConvergedJointScope {
  readonly kind: 'platform' | 'club' | 'department';
  readonly clubId?: string;
  readonly participantClubIds: readonly string[];
  readonly departmentIds: readonly string[];
  readonly privileged: boolean;
}

/**
 * 收敛 principal 对指定联合活动的统计作用域。
 * 参与方向：仅该活动参与方社团的角色可查看；超管全可见。
 */
export function convergeJointScope(
  principal: StatisticsPrincipal,
  participantClubIds: readonly string[],
): ConvergedJointScope | null {
  if (principal.isPlatformSuperAdmin) {
    return {
      kind: 'platform',
      participantClubIds,
      departmentIds: [],
      privileged: true,
    };
  }

  // 找第一个匹配的参与方社团
  for (const scope of principal.clubScopes) {
    if (participantClubIds.includes(scope.clubId)) {
      return {
        kind: scope.level,
        clubId: scope.clubId,
        participantClubIds,
        departmentIds: scope.level === 'department' ? scope.departmentIds : [],
        privileged: false,
      };
    }
  }

  return null;
}

/**
 * 收敛并断言：无权抛出 forbidden。
 */
export function requireJointScope(
  principal: StatisticsPrincipal,
  participantClubIds: readonly string[],
): ConvergedJointScope {
  const scope = convergeJointScope(principal, participantClubIds);
  if (scope === null) {
    throw statisticsErrors.forbidden(`用户 ${principal.userId} 无权查看该联合活动统计（STAT-002）`);
  }
  return scope;
}

// ---------------------------------------------------------------------------
// 停用撤权（STAT-002）
// ---------------------------------------------------------------------------

/**
 * 社团紧急停用撤权（STAT-002）。超管不受停用限制；停用社团的统计一律撤权。
 * 三个查询用例（社团/漏斗/联合）共用同一实现，避免口径漂移。
 */
export async function assertClubNotSuspended(
  source: StatisticsSourcePort,
  clubId: string,
  principal: StatisticsPrincipal,
  context: string,
): Promise<void> {
  if (principal.isPlatformSuperAdmin) return;
  const profile = await source.loadClubProfile(clubId);
  if (profile !== null && profile.forcedSuspension) {
    throw statisticsErrors.precondition(
      `社团 ${clubId} 处于紧急停用状态，${context}撤权（STAT-002）`,
    );
  }
}
