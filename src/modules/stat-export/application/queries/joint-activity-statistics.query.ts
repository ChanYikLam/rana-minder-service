/**
 * 联合活动统计查询（JointActivityStatisticsQuery，STAT-002）。
 *
 * 联合活动参与社团可查看该活动的精确统计和各社团在该活动中的结论统计。
 * 边界（STAT-002）：
 * - 不能由此访问对方其他活动（源端只返回单活动事实，跨活动不可达）；
 * - 因参与方已可查看共享明细，管理统计不做小样本模糊化；
 * - 紧急停用社团的统计撤权：停用参与方不能访问；
 * - 全局与精确统计访问均须审计。
 *
 * REQUIREMENT：参与方之外的社团及普通成员/申请人均拒绝访问。
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
import { assertClubNotSuspended, requireJointScope } from '../statistics-scope';
import { statisticsErrors } from '../statistics-errors';

// ---------------------------------------------------------------------------
// 输入
// ---------------------------------------------------------------------------

export interface JointStatisticsInput {
  readonly principal: StatisticsPrincipal;
  readonly jointActivityId: string;
  readonly filters?: StatisticsFilters;
}

// ---------------------------------------------------------------------------
// 输出视图
// ---------------------------------------------------------------------------

export interface JointActivityStatsView {
  readonly jointActivityId: string;
  readonly scope: { kind: string; clubId?: string; departmentIds: readonly string[] };
  readonly byClub: ReadonlyArray<{
    readonly clubId: string;
    readonly clubName: string | null;
    readonly total: number;
    readonly accepted: number;
    readonly rejected: number;
    readonly pending: number;
  }>;
  readonly exactValues: true;
  readonly smallSampleMaskingApplied: false;
  readonly caliber: {
    readonly jointActivityExactStats: true;
    readonly leaderboardProvided: false;
  };
}

// ---------------------------------------------------------------------------
// 查询用例
// ---------------------------------------------------------------------------

@Injectable()
export class JointActivityStatisticsQuery {
  constructor(
    @Inject(STATISTICS_SOURCE) private readonly source: StatisticsSourcePort,
    @Inject(STATISTICS_AUDIT_PORT) private readonly audit: StatisticsAuditPort,
    private readonly spec: StatisticsSpecification,
  ) {}

  async statistics(input: JointStatisticsInput): Promise<JointActivityStatsView> {
    const { principal, jointActivityId, filters } = input;

    // 加载联合活动引用
    const activity = await this.source.loadJointActivity(jointActivityId);
    if (activity === null) {
      throw statisticsErrors.notVisible(`联合活动不存在：${jointActivityId}`);
    }

    // 作用域收敛（仅参与方 / 超管）
    const scope = requireJointScope(principal, activity.participantClubIds);

    // 停用检查：参与方社团紧急停用 → 撤权
    if (scope.kind !== 'platform') {
      await assertClubNotSuspended(this.source, scope.clubId!, principal, '联合统计');
    }

    // 断言单一联合口径
    this.spec.assertSingleScope('joint');

    // 只读回源
    const facts = await this.source.loadJointConclusionFacts(jointActivityId);

    // 部门作用域过滤：本社团的 facts 按部门过滤；其他社团的 facts 全部保留（STAT-002）
    const scopedFacts =
      scope.kind === 'department' && scope.clubId
        ? facts.filter((f) => {
            if (f.clubId === scope.clubId) {
              return f.departmentId !== null && scope.departmentIds.includes(f.departmentId);
            }
            return true; // 其他社团结论全部可见
          })
        : facts;

    // 精确结论（不做小样本模糊化）
    const conclusion = this.spec.jointConclusionStats(scopedFacts, filters);

    // 审计（精确统计访问均须审计，超管特权审计）
    await this.audit.record({
      at: new Date().toISOString(),
      action: 'joint_activity_stats',
      principalId: principal.userId,
      privileged: scope.privileged,
      clubId: scope.clubId ?? null,
      jointActivityId,
      outcome: 'allowed',
    });

    return {
      jointActivityId,
      scope: { kind: scope.kind, clubId: scope.clubId, departmentIds: scope.departmentIds },
      byClub: conclusion.byClub,
      exactValues: true,
      smallSampleMaskingApplied: false,
      caliber: {
        jointActivityExactStats: true,
        leaderboardProvided: false,
      },
    };
  }
}
