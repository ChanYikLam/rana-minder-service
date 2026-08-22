/**
 * 普通招新漏斗查询（RecruitmentFunnelQuery，STAT-002）。
 *
 * 只适用于普通招新活动（联合活动漏斗经 JointActivityStatisticsQuery）。
 * 阶段统计口径严格与普通招新绑定，不混合联合活动事实。
 *
 * 部门负责人：仅能看到本部门的漏斗数据（departmentId 匹配的申请者）；
 * 未定部门申请对部门负责人不可见。
 */

import { Inject, Injectable } from '@nestjs/common';
import {
  StatisticsSpecification,
  type StatisticsFilters,
} from '../../domain/models/statistics-specification';
import { STATISTICS_SOURCE, type StatisticsSourcePort } from '../ports/statistics-source.port';
import {
  STATISTICS_AUDIT_PORT,
  type StatisticsAuditPort,
  type StatisticsPrincipal,
} from '../ports/statistics-authorization.port';
import { requireClubScope } from '../statistics-scope';
import { statisticsErrors } from '../statistics-errors';

// ---------------------------------------------------------------------------
// 输入
// ---------------------------------------------------------------------------

export interface FunnelInput {
  readonly principal: StatisticsPrincipal;
  readonly clubId: string;
  readonly activityId: string;
  readonly filters?: StatisticsFilters;
}

// ---------------------------------------------------------------------------
// 输出视图
// ---------------------------------------------------------------------------

export interface FunnelView {
  readonly clubId: string;
  readonly activityId: string;
  readonly academicYear: string | null;
  readonly scope: { level: string; departmentIds: readonly string[] };
  readonly stages: {
    applied: number;
    attendedInterview: number;
    invited: number;
    invitationAccepted: number;
  };
  readonly orderedChoices: {
    readonly applicantsWithChoices: number;
    readonly totalChoiceCount: number;
  };
  readonly adjustment: {
    readonly accepts: number;
    readonly declines: number;
    readonly unspecified: number;
  };
  readonly caliber: {
    readonly normalRecruitmentOnly: true;
    readonly leaderboardProvided: false;
  };
}

// ---------------------------------------------------------------------------
// 查询用例
// ---------------------------------------------------------------------------

@Injectable()
export class RecruitmentFunnelQuery {
  constructor(
    @Inject(STATISTICS_SOURCE) private readonly source: StatisticsSourcePort,
    @Inject(STATISTICS_AUDIT_PORT) private readonly audit: StatisticsAuditPort,
    private readonly spec: StatisticsSpecification,
  ) {}

  async funnel(input: FunnelInput): Promise<FunnelView> {
    const { principal, clubId, activityId, filters } = input;
    const scope = requireClubScope(principal, clubId);

    // 停用检查
    await this.assertNotSuspended(clubId, principal);

    // 活动必须属于该社团且为普通招新
    const activityRef = await this.source.loadNormalActivity(activityId);
    if (activityRef === null || activityRef.clubId !== clubId) {
      throw statisticsErrors.notVisible(`招新活动不存在或不属于该社团：${activityId}`);
    }

    // 断言普通口径
    this.spec.assertSingleScope('normal');

    // 只读回源漏斗事实
    const facts = await this.source.loadNormalFunnelFacts(activityId);

    // 作用域过滤（部门负责人仅见本部门事实）
    const scopedFacts =
      scope.kind === 'department'
        ? facts.filter(
            (f) => f.departmentId !== null && scope.departmentIds.includes(f.departmentId),
          )
        : facts;

    // 口径计算
    const { stages, orderedChoices, adjustment } = this.spec.recruitmentFunnel(
      scopedFacts,
      filters,
    );

    // 审计
    await this.audit.record({
      at: new Date().toISOString(),
      action: 'recruitment_funnel',
      principalId: principal.userId,
      privileged: scope.privileged,
      clubId,
      jointActivityId: null,
      outcome: 'allowed',
    });

    return {
      clubId,
      activityId,
      academicYear: activityRef.academicYear,
      scope: { level: scope.kind, departmentIds: scope.departmentIds },
      stages,
      orderedChoices,
      adjustment,
      caliber: {
        normalRecruitmentOnly: true,
        leaderboardProvided: false,
      },
    };
  }

  private async assertNotSuspended(clubId: string, principal: StatisticsPrincipal): Promise<void> {
    if (principal.isPlatformSuperAdmin) return;
    const profile = await this.source.loadClubProfile(clubId);
    if (profile !== null && profile.forcedSuspension) {
      throw statisticsErrors.precondition(`社团 ${clubId} 处于紧急停用状态，统计撤权（STAT-002）`);
    }
  }
}
