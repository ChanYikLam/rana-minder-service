/**
 * 社团统计查询（ClubStatisticsQuery，STAT-002）。
 *
 * 作用域收敛（STAT-002）：
 * - 社团负责人/人事管理员：本社团全量统计；
 * - 部门负责人：仅本部门范围的成员/录取历史；
 * - 普通成员与申请人：拒绝；
 * - 超级管理员：全平台（经 admin/stats 端点），特权审计。
 *
 * 汇总与下钻分离（STAT-003）：
 * - summary() 返回缩略指标 + 部门分布 + 口径声明；
 * - drilldown() 返回记录级明细，继续执行记录级权限检查。
 * - 下钻输入度量名硬关闭排行榜/排名（assertLeaderboardClosed）。
 */

import { Inject, Injectable } from '@nestjs/common';
import {
  StatisticsSpecification,
  type StatisticsFilters,
} from '../../domain/models/statistics-specification';
import { STATISTICS_SOURCE, type StatisticsSourcePort } from '../ports/statistics-source.port';
import { topKSorted } from '../sort-utils';
import {
  STATISTICS_AUDIT_PORT,
  type StatisticsAuditPort,
  type StatisticsPrincipal,
  type StatisticsAccessAction,
} from '../ports/statistics-authorization.port';
import { requireClubScope } from '../statistics-scope';
import { statisticsErrors } from '../statistics-errors';

// ---------------------------------------------------------------------------
// 输入
// ---------------------------------------------------------------------------

export interface ClubStatisticsInput {
  readonly principal: StatisticsPrincipal;
  readonly clubId: string;
  readonly filters?: StatisticsFilters;
}

export interface ClubDrillDownInput extends ClubStatisticsInput {
  readonly metric: string;
  readonly limit?: number;
}

// ---------------------------------------------------------------------------
// 输出视图
// ---------------------------------------------------------------------------

export interface ClubStatsSummaryView {
  readonly clubId: string;
  readonly scope: { level: string; departmentIds: readonly string[] };
  readonly generatedAt: string;
  readonly summary: ReadonlyArray<{
    label: string;
    value: number;
    trend: 'up' | 'flat' | 'down';
    trendValue: number;
    caliberNote?: string;
  }>;
  readonly departmentDistribution: ReadonlyArray<{
    departmentId: string;
    departmentName: string | null;
    memberCount: number;
  }>;
  readonly caliber: {
    normalAndJointSeparated: true;
    leaderboardProvided: false;
    admissionHistorySeparateFromCurrent: true;
  };
}

export interface ClubDrillDownView {
  readonly metric: string;
  readonly rows: ReadonlyArray<Record<string, unknown>>;
  readonly totalCount: number;
  readonly caliber: {
    rankedOutput: false;
  };
}

// ---------------------------------------------------------------------------
// 查询用例
// ---------------------------------------------------------------------------

@Injectable()
export class ClubStatisticsQuery {
  constructor(
    @Inject(STATISTICS_SOURCE) private readonly source: StatisticsSourcePort,
    @Inject(STATISTICS_AUDIT_PORT) private readonly audit: StatisticsAuditPort,
    private readonly spec: StatisticsSpecification,
  ) {}

  // -----------------------------------------------------------------------
  // 汇总
  // -----------------------------------------------------------------------

  async summary(input: ClubStatisticsInput): Promise<ClubStatsSummaryView> {
    const { principal, clubId, filters } = input;
    const scope = requireClubScope(principal, clubId);

    // 停用检查
    await this.assertNotSuspended(clubId, principal);

    // 只读回源
    const [memberships, history] = await Promise.all([
      this.source.loadMembershipFacts(clubId),
      this.source.loadAdmissionHistory(clubId),
    ]);

    // 按作用域过滤事实
    const scopedMemberships =
      scope.kind === 'department'
        ? memberships.filter(
            (m) => m.departmentId !== null && scope.departmentIds.includes(m.departmentId),
          )
        : memberships;
    const scopedHistory =
      scope.kind === 'department'
        ? history.filter(
            (h) => h.departmentId !== null && scope.departmentIds.includes(h.departmentId),
          )
        : history;

    // 口径计算
    const { admissionHistory } = this.spec.splitAdmissionHistoryAndCurrent(
      scopedHistory,
      scopedMemberships,
      filters,
    );
    const dist = this.spec.departmentDistribution(scopedMemberships, filters);
    const currentTotal = this.spec.uniqueStudentCount(scopedMemberships, filters);

    // 趋势（按学年 buckets）
    const memberByYear = this.groupMembersByYear(scopedMemberships);
    const historyByYear = this.groupHistoryByYear(scopedHistory);
    const currentYear = filters?.academicYear ?? undefined;
    const memberTrend = this.spec.computeTrend(currentYear, currentTotal, memberByYear);
    const historyTrend = this.spec.computeTrend(
      currentYear,
      admissionHistory.totalAccepted,
      historyByYear,
    );

    // 审计
    await this.audit.record({
      at: new Date().toISOString(),
      action: 'club_summary',
      principalId: principal.userId,
      privileged: scope.privileged,
      clubId,
      jointActivityId: null,
      outcome: 'allowed',
    });

    const now = new Date().toISOString();
    return {
      clubId,
      scope: { level: scope.kind, departmentIds: scope.departmentIds },
      generatedAt: now,
      summary: [
        {
          label: '当前成员总数',
          value: currentTotal,
          ...memberTrend,
        },
        {
          label: '录取历史（普通招新）',
          value: admissionHistory.normalTotal,
          ...historyTrend,
          caliberNote: '普通招新接受事件计数，不兼容联合活动口径',
        },
        {
          label: '录取历史（联合活动）',
          value: admissionHistory.jointTotal,
          ...historyTrend,
          caliberNote: '联合活动接受事件计数，不兼容普通招新口径',
        },
        {
          label: '部门数',
          value: dist.length,
          trend: 'flat' as const,
          trendValue: 0,
        },
      ],
      departmentDistribution: dist.map((d) => ({
        departmentId: d.departmentId,
        departmentName: d.departmentName,
        memberCount: d.memberCount,
      })),
      caliber: {
        normalAndJointSeparated: true,
        leaderboardProvided: false,
        admissionHistorySeparateFromCurrent: true,
      },
    };
  }

  // -----------------------------------------------------------------------
  // 下钻
  // -----------------------------------------------------------------------

  async drilldown(input: ClubDrillDownInput): Promise<ClubDrillDownView> {
    const { principal, clubId, metric, filters } = input;
    const scope = requireClubScope(principal, clubId);

    // 排行榜关闭
    this.spec.assertLeaderboardClosed(metric);

    // 停用检查
    await this.assertNotSuspended(clubId, principal);

    const limit = Math.min(Math.max(input.limit ?? 200, 1), 1000);

    let rows: Record<string, unknown>[];
    const action: StatisticsAccessAction = 'club_drilldown';

    if (metric === 'current_members') {
      const memberships = await this.source.loadMembershipFacts(clubId);
      const scoped =
        scope.kind === 'department'
          ? memberships.filter(
              (m) => m.departmentId !== null && scope.departmentIds.includes(m.departmentId),
            )
          : memberships;
      const filtered = filters
        ? scoped.filter((m) => {
            if (filters.departmentId && m.departmentId !== filters.departmentId) return false;
            if (filters.academicYear && m.academicYear !== filters.academicYear) return false;
            return true;
          })
        : scoped;

      // 稳定取前 limit 行：学号升序（非评分/排名序列），top-k 部分排序避免全量排序
      rows = topKSorted(filtered, (m) => m.studentNo, limit).map((m) => ({
        userId: m.userId,
        studentNo: m.studentNo,
        departmentId: m.departmentId,
        departmentName: m.departmentName,
        positionId: m.positionId,
        academicYear: m.academicYear,
      }));
      this.spec.assertNoRankedOutput(rows);

      await this.audit.record({
        at: new Date().toISOString(),
        action,
        principalId: principal.userId,
        privileged: scope.privileged,
        clubId,
        jointActivityId: null,
        outcome: 'allowed',
      });

      return { metric, rows, totalCount: filtered.length, caliber: { rankedOutput: false } };
    }

    if (metric === 'admission_history') {
      const history = await this.source.loadAdmissionHistory(clubId);
      const scoped =
        scope.kind === 'department'
          ? history.filter(
              (h) => h.departmentId !== null && scope.departmentIds.includes(h.departmentId),
            )
          : history;
      const filtered = filters
        ? scoped.filter((h) => {
            if (filters.departmentId && h.departmentId !== filters.departmentId) return false;
            if (filters.academicYear && h.academicYear !== filters.academicYear) return false;
            if (filters.timeRange) {
              if (h.acceptedAt < filters.timeRange.from) return false;
              if (h.acceptedAt > filters.timeRange.to) return false;
            }
            return true;
          })
        : scoped;

      // 稳定取前 limit 行：接受时间升序，top-k 部分排序
      rows = topKSorted(filtered, (h) => h.acceptedAt, limit).map((h) => ({
        userId: h.userId,
        studentNo: h.studentNo,
        recruitmentActivityId: h.recruitmentActivityId,
        activityName: h.activityName,
        scope: h.scope,
        acceptedAt: h.acceptedAt,
        departmentId: h.departmentId,
        departmentName: h.departmentName,
        academicYear: h.academicYear,
      }));
      this.spec.assertNoRankedOutput(rows);

      await this.audit.record({
        at: new Date().toISOString(),
        action,
        principalId: principal.userId,
        privileged: scope.privileged,
        clubId,
        jointActivityId: null,
        outcome: 'allowed',
      });

      return { metric, rows, totalCount: filtered.length, caliber: { rankedOutput: false } };
    }

    // 未知度量名
    throw statisticsErrors.validation(
      `未知下钻度量："${metric}"（支持：current_members, admission_history）`,
    );
  }

  // -----------------------------------------------------------------------
  // 平台汇总（超管专用）
  // -----------------------------------------------------------------------

  async platformSummary(principal: StatisticsPrincipal): Promise<ClubStatsSummaryView> {
    if (!principal.isPlatformSuperAdmin) {
      throw statisticsErrors.forbidden('仅超级管理员可查看全平台统计（STAT-002）');
    }

    const [memberships, history] = await Promise.all([
      this.source.loadPlatformMembershipFacts(),
      this.source.loadPlatformAdmissionHistory(),
    ]);

    const { admissionHistory } = this.spec.splitAdmissionHistoryAndCurrent(history, memberships);
    const dist = this.spec.departmentDistribution(memberships);
    const currentTotal = this.spec.uniqueStudentCount(memberships);

    await this.audit.record({
      at: new Date().toISOString(),
      action: 'platform_summary',
      principalId: principal.userId,
      privileged: true,
      clubId: null,
      jointActivityId: null,
      outcome: 'allowed',
    });

    const now = new Date().toISOString();
    return {
      clubId: '__PLATFORM__',
      scope: { level: 'club', departmentIds: [] },
      generatedAt: now,
      summary: [
        { label: '全平台当前成员总数', value: currentTotal, trend: 'flat', trendValue: 0 },
        {
          label: '全平台录取历史（普通）',
          value: admissionHistory.normalTotal,
          trend: 'flat',
          trendValue: 0,
        },
        {
          label: '全平台录取历史（联合）',
          value: admissionHistory.jointTotal,
          trend: 'flat',
          trendValue: 0,
        },
      ],
      departmentDistribution: dist.map((d) => ({
        departmentId: d.departmentId,
        departmentName: d.departmentName,
        memberCount: d.memberCount,
      })),
      caliber: {
        normalAndJointSeparated: true,
        leaderboardProvided: false,
        admissionHistorySeparateFromCurrent: true,
      },
    };
  }

  // -----------------------------------------------------------------------
  // 内部辅助
  // -----------------------------------------------------------------------

  private async assertNotSuspended(clubId: string, principal: StatisticsPrincipal): Promise<void> {
    if (principal.isPlatformSuperAdmin) return; // 超管不受停用限制
    const profile = await this.source.loadClubProfile(clubId);
    if (profile !== null && profile.forcedSuspension) {
      throw statisticsErrors.precondition(`社团 ${clubId} 处于紧急停用状态，统计撤权（STAT-002）`);
    }
  }

  private groupMembersByYear(
    memberships: readonly { academicYear: string }[],
  ): Map<string, number> {
    const map = new Map<string, number>();
    for (const m of memberships) {
      map.set(m.academicYear, (map.get(m.academicYear) ?? 0) + 1);
    }
    return map;
  }

  private groupHistoryByYear(history: readonly { academicYear: string }[]): Map<string, number> {
    const map = new Map<string, number>();
    for (const h of history) {
      map.set(h.academicYear, (map.get(h.academicYear) ?? 0) + 1);
    }
    return map;
  }
}
