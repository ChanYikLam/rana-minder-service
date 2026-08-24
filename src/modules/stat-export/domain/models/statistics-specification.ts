/**
 * 统计口径规范（StatisticsSpecification，STAT-001/002/003）。
 *
 * 领域层纯规则：不依赖任何外部技术栈（分层实现规范 §1/§2），只对
 * 正式业务记录投影出的事实做纯函数计算——统计值只能从正式业务记录计算，
 * 任何角色不能直接改写统计数字（STAT-003）。
 *
 * 口径硬规则（STAT-001）：
 * - 普通招新与联合活动分别统计，绝不混合进同一个数；
 * - 一个学生同属多个部门：部门分布中每个部门分别计入，社团总数按学号去重；
 * - 当前产品不提供成员排行榜、自动评分或人员优劣排名；
 * - 录取历史（邀请接受即成立）与当前成员分算：后续成员移除不改写录取历史（STAT-003）。
 *
 * 导出基线（EXP-001/EXP-002）：
 * - 5.4.2~5.4.4 导出复用本规范的字段范围基线，保证"统计口径 = 导出口径"一致；
 * - 联系方式默认不导出、秘密标识永不导出。
 */

// ---------------------------------------------------------------------------
// 口径基础类型
// ---------------------------------------------------------------------------

/** 统计范围口径（STAT-001：普通/联合不混合） */
export type StatScopeKind = 'normal' | 'joint';

/** 时间范围（含边界） */
export interface StatisticsTimeRange {
  readonly from: string; // ISO date
  readonly to: string;
}

/** 统计筛选条件 */
export interface StatisticsFilters {
  readonly academicYear?: string | null;
  readonly recruitmentActivityId?: string | null;
  readonly departmentId?: string | null;
  readonly timeRange?: StatisticsTimeRange | null;
}

/** 部门分布中「无部门归属」成员使用的内部占位键（统计后过滤，不对外暴露） */
const NO_DEPARTMENT_KEY = '__NO_DEPT__';

// ---------------------------------------------------------------------------
// 事实类型（正式业务记录投影；只读不修改）
// ---------------------------------------------------------------------------

/** 当前成员关系事实（STAT-003：只读回源） */
export interface MembershipFact {
  readonly userId: string;
  readonly studentNo: string;
  readonly departmentId: string | null;
  readonly departmentName: string | null;
  readonly positionId: string | null;
  readonly academicYear: string; // e.g. "2025-2026"
}

/** 录取历史事实（STAT-003：邀请接受即成立、不随后续移除改写） */
export interface AdmissionAcceptanceFact {
  readonly userId: string;
  readonly studentNo: string;
  readonly recruitmentActivityId: string;
  readonly activityName: string | null;
  readonly scope: StatScopeKind;
  readonly acceptedAt: string;
  readonly departmentId: string | null;
  readonly departmentName: string | null;
  readonly academicYear: string;
}

/** 普通招新漏斗事实（每申请人一条） */
export interface NormalFunnelFact {
  readonly applicationId: string;
  readonly applicantId: string;
  readonly appliedAt: string;
  readonly departmentId: string | null;
  readonly departmentName: string | null;
  readonly attendedInterview: boolean;
  readonly invitedAt: string | null;
  readonly invitationAcceptedAt: string | null;
  readonly orderedChoiceCount: number;
  readonly acceptsAdjustment: boolean | null;
}

/** 联合活动结论事实 */
export interface JointConclusionFact {
  readonly jointActivityId: string;
  readonly clubId: string;
  readonly clubName: string | null;
  readonly applicantId: string;
  readonly departmentId: string | null;
  readonly departmentName: string | null;
  readonly conclusion: 'accepted' | 'rejected' | 'pending';
  readonly concludedAt: string | null;
}

// ---------------------------------------------------------------------------
// 口径统计输出 view
// ---------------------------------------------------------------------------

export interface DepartmentDistributionRow {
  readonly departmentId: string;
  readonly departmentName: string | null;
  readonly memberCount: number;
}

export interface SummaryItem {
  readonly label: string;
  readonly value: number;
  readonly trend: 'up' | 'flat' | 'down';
  readonly trendValue: number;
  /** 口径说明（如 "普通招新录取"、"联合活动录取"） */
  readonly caliberNote?: string;
}

export interface SplitHistoryView {
  readonly admissionHistory: {
    readonly totalAccepted: number; // 事件计数（非去重人数）
    readonly normalTotal: number;
    readonly jointTotal: number;
    readonly byActivity: ReadonlyArray<{
      readonly recruitmentActivityId: string;
      readonly activityName: string | null;
      readonly accepted: number;
      readonly scope: StatScopeKind;
    }>;
  };
  readonly currentMembers: {
    readonly total: number; // 以学号去重
  };
}

export interface FunnelStageView {
  readonly applied: number;
  readonly attendedInterview: number;
  readonly invited: number;
  readonly invitationAccepted: number;
}

export interface FunnelChoiceStats {
  readonly applicantsWithChoices: number;
  readonly totalChoiceCount: number;
}

export interface FunnelAdjustmentStats {
  readonly accepts: number;
  readonly declines: number;
  readonly unspecified: number;
}

export interface JointClubConclusionView {
  readonly clubId: string;
  readonly clubName: string | null;
  readonly total: number;
  readonly accepted: number;
  readonly rejected: number;
  readonly pending: number;
}

export interface JointConclusionStatsView {
  readonly participantsExact: true;
  readonly byClub: readonly JointClubConclusionView[];
}

// ---------------------------------------------------------------------------
// 口径违规错误
// ---------------------------------------------------------------------------

export type CaliberViolationReason =
  | 'MIXED_SCOPE_CALIBER' // 普通/联合混合
  | 'HISTORY_CURRENT_MIXED' // 录取历史与当前成员混同
  | 'LEADERBOARD_FORBIDDEN' // 排行榜被禁止
  | 'RANKED_OUTPUT_FORBIDDEN'; // 输出含排名/评分

export class StatisticsCaliberError extends Error {
  constructor(
    readonly reason: CaliberViolationReason,
    message: string,
  ) {
    super(message);
    this.name = 'StatisticsCaliberError';
  }
}

// ---------------------------------------------------------------------------
// 导出字段基线（EXP-001/EXP-002：统计口径 = 导出口径）
// ---------------------------------------------------------------------------

export const EXPORT_DATASET_TYPES = [
  'club_summary',
  'current_members',
  'admission_history',
  'recruitment_funnel',
  'joint_conclusions',
] as const;

export type ExportDatasetType = (typeof EXPORT_DATASET_TYPES)[number];

/** 字段基线：联系方式不在默认导出范围内、秘密标识永不出现 */
export const EXPORT_FIELD_GROUPS: Record<ExportDatasetType, readonly string[]> = {
  club_summary: ['metric', 'value', 'scope', 'academicYear', 'trend', 'trendValue'],
  current_members: [
    'userId',
    'studentNo',
    'departmentId',
    'departmentName',
    'positionId',
    'academicYear',
  ],
  admission_history: [
    'userId',
    'studentNo',
    'recruitmentActivityId',
    'activityName',
    'scope',
    'acceptedAt',
    'departmentId',
    'departmentName',
    'academicYear',
  ],
  recruitment_funnel: [
    'stage',
    'count',
    'applicantsWithChoices',
    'totalChoiceCount',
    'adjustmentAccepts',
    'adjustmentDeclines',
    'adjustmentUnspecified',
  ],
  joint_conclusions: [
    'jointActivityId',
    'clubId',
    'clubName',
    'conclusion',
    'total',
    'accepted',
    'rejected',
    'pending',
  ],
};

/** 绝不允许出现在导出中的字段（秘密标识等） */
const NEVER_EXPORT_FIELDS = new Set([
  'idCard',
  'secretFlag',
  'internalNote',
  'secretMark',
  'phone',
  'email', // EXP-002：默认不导出联系方式
]);

// ---------------------------------------------------------------------------
// 口径规则
// ---------------------------------------------------------------------------

function matchesFilters(
  fact: { academicYear?: string; departmentId?: string | null },
  filters: StatisticsFilters | undefined,
): boolean {
  if (!filters) return true;
  if (filters.academicYear && fact.academicYear !== filters.academicYear) return false;
  if (filters.departmentId && fact.departmentId !== filters.departmentId) return false;
  return true;
}

function matchesMembership(fact: MembershipFact, filters: StatisticsFilters | undefined): boolean {
  if (!filters) return true;
  if (filters.academicYear && fact.academicYear !== filters.academicYear) return false;
  if (filters.departmentId && fact.departmentId !== filters.departmentId) return false;
  return true;
}

function matchesAdmission(
  fact: AdmissionAcceptanceFact,
  filters: StatisticsFilters | undefined,
): boolean {
  if (!filters) return true;
  if (filters.academicYear && fact.academicYear !== filters.academicYear) return false;
  if (filters.departmentId && fact.departmentId !== filters.departmentId) return false;
  if (filters.timeRange) {
    if (fact.acceptedAt < filters.timeRange.from) return false;
    if (fact.acceptedAt > filters.timeRange.to) return false;
  }
  return true;
}

function matchesFunnel(fact: NormalFunnelFact, filters: StatisticsFilters | undefined): boolean {
  if (!filters) return true;
  if (filters.departmentId && fact.departmentId !== filters.departmentId) return false;
  if (filters.timeRange) {
    if (fact.appliedAt < filters.timeRange.from) return false;
    if (fact.appliedAt > filters.timeRange.to) return false;
  }
  return true;
}

function matchesJointConclusion(
  _fact: JointConclusionFact,
  _filters: StatisticsFilters | undefined,
): boolean {
  // 联合结论不按 filters 过滤：部门作用域收敛由查询用例在 scopedFacts 中按
  // 「本社团按部门、其他参与方社团全可见」逐条完成（STAT-002），此处若再按
  // departmentId 一刀切过滤会把其他社团的结论一并隐藏，造成口径漂移（STAT-001）。
  return true;
}

/**
 * 解析 "2025-2026" → 前一年 "2024-2025"；格式不符返回 null。
 */
function previousAcademicYear(label: string): string | null {
  const m = /^(\d{4})-(\d{4})$/.exec(label);
  if (m === null) return null;
  const start = Number(m[1]);
  const end = Number(m[2]);
  if (end !== start + 1) return null;
  return `${start - 1}-${end - 1}`;
}

/**
 * 口径规范：所有统计规则的纯函数容器。领域层 singleton，可被导出模块注入以复用手工基线。
 */
export class StatisticsSpecification {
  // -------------------------------------------------------------------------
  // 口径分离
  // -------------------------------------------------------------------------

  /**
   * 断言两个口径不混合：normal + joint 交叉聚合抛出 MIXED_SCOPE_CALIBER。
   * 调用方应先声明单个口径，再传入同口径事实。
   */
  assertScopeSeparated(a: StatScopeKind, b: StatScopeKind): void {
    if (a !== b) {
      throw new StatisticsCaliberError(
        'MIXED_SCOPE_CALIBER',
        `普通招新与联合活动统计不可混合（STAT-001）：${a} × ${b}`,
      );
    }
  }

  /**
   * 声明聚合入口的单一口径（编码到 view 元数据，STAT-001）。
   * 仅接受 `normal`/`joint` 两个合法单口径，拒绝未知口径——本质是防御性
   * 断言，供各查询入口声明「本次只处理一种口径」的意图；真正的混合防护由
   * `assertScopeSeparated` 在聚合路径上强制（同一入口不会混入异口径事实）。
   */
  assertSingleScope(scope: StatScopeKind): void {
    if (scope !== 'normal' && scope !== 'joint') {
      throw new StatisticsCaliberError('MIXED_SCOPE_CALIBER', `未知统计口径：${scope}`);
    }
  }

  // -------------------------------------------------------------------------
  // 去重与分布
  // -------------------------------------------------------------------------

  /**
   * 按学号去重计数（社团总人数 / 平台总人数，STAT-001 多部门去重）。
   */
  uniqueStudentCount(
    facts: ReadonlyArray<{
      readonly studentNo: string;
      readonly academicYear?: string;
      readonly departmentId?: string | null;
    }>,
    filters?: StatisticsFilters,
  ): number {
    const filtered = filters ? facts.filter((f) => matchesFilters(f, filters)) : facts;
    return new Set(filtered.map((f) => f.studentNo)).size;
  }

  /**
   * 部门分布：一个成员属于多个部门时，每个部门分别计数（STAT-001）。
   * 筛选后计算，部门负责人 scope 应由调用方预先过滤 facts。
   */
  departmentDistribution(
    facts: ReadonlyArray<MembershipFact>,
    filters?: StatisticsFilters,
  ): DepartmentDistributionRow[] {
    const map = new Map<string, { id: string; name: string | null; count: number }>();
    for (const f of facts) {
      if (!matchesMembership(f, filters)) continue;
      const deptId = f.departmentId ?? NO_DEPARTMENT_KEY;
      const row = map.get(deptId) ?? { id: deptId, name: f.departmentName ?? null, count: 0 };
      row.count += 1;
      map.set(deptId, row);
    }
    return [...map.entries()]
      .filter(([key]) => key !== NO_DEPARTMENT_KEY)
      .map(([_, v]) => ({ departmentId: v.id, departmentName: v.name, memberCount: v.count }));
  }

  // -------------------------------------------------------------------------
  // 录取历史与当前成员分算
  // -------------------------------------------------------------------------

  /**
   * 录取历史与当前成员分别计算：历史事件计数，当前成员去重人数（STAT-003）。
   * 绝不返回一个混合的"总成员数"。
   */
  splitAdmissionHistoryAndCurrent(
    historyFacts: ReadonlyArray<AdmissionAcceptanceFact>,
    membershipFacts: ReadonlyArray<MembershipFact>,
    filters?: StatisticsFilters,
  ): SplitHistoryView {
    const historyFiltered = filters
      ? historyFacts.filter((h) => matchesAdmission(h, filters))
      : historyFacts;
    const memberFiltered = filters
      ? membershipFacts.filter((m) => matchesMembership(m, filters))
      : membershipFacts;

    // 历史：按范围split normal/joint分别计数事件（非去重——接受事件可重复）
    const normalHistory = historyFiltered.filter((h) => h.scope === 'normal');
    const jointHistory = historyFiltered.filter((h) => h.scope === 'joint');

    // 按活动聚合
    const byActivityMap = new Map<
      string,
      {
        id: string;
        name: string | null;
        normal: number;
        joint: number;
      }
    >();
    for (const h of historyFiltered) {
      const entry = byActivityMap.get(h.recruitmentActivityId) ?? {
        id: h.recruitmentActivityId,
        name: h.activityName ?? null,
        normal: 0,
        joint: 0,
      };
      if (h.scope === 'normal') entry.normal += 1;
      else entry.joint += 1;
      byActivityMap.set(h.recruitmentActivityId, entry);
    }

    return {
      admissionHistory: {
        totalAccepted: historyFiltered.length,
        normalTotal: normalHistory.length,
        jointTotal: jointHistory.length,
        byActivity: [...byActivityMap.values()].flatMap((e) => {
          const items: Array<{
            recruitmentActivityId: string;
            activityName: string | null;
            accepted: number;
            scope: StatScopeKind;
          }> = [];
          if (e.normal > 0)
            items.push({
              recruitmentActivityId: e.id,
              activityName: e.name,
              accepted: e.normal,
              scope: 'normal',
            });
          if (e.joint > 0)
            items.push({
              recruitmentActivityId: e.id,
              activityName: e.name,
              accepted: e.joint,
              scope: 'joint',
            });
          return items;
        }),
      },
      currentMembers: {
        total: this.uniqueStudentCount(memberFiltered),
      },
    };
  }

  // -------------------------------------------------------------------------
  // 排行榜关闭
  // -------------------------------------------------------------------------

  /** 排行榜/评分/排名相关视图标识，命中即禁止（STAT-001）。 */
  private static readonly FORBIDDEN_VIEW_TOKENS = [
    'leaderboard',
    'ranking',
    'ranking_list',
    'top_members',
    'member_score',
    'person_rank',
    'scoreboard',
  ];

  /**
   * 硬断言视图请求或度量名不含排行榜/排名相关标识。
   * 供 query / controller 调用。
   */
  assertLeaderboardClosed(viewNameOrMetric: string): void {
    const lower = viewNameOrMetric.toLowerCase();
    for (const token of StatisticsSpecification.FORBIDDEN_VIEW_TOKENS) {
      if (lower.includes(token)) {
        throw new StatisticsCaliberError(
          'LEADERBOARD_FORBIDDEN',
          `视图「${viewNameOrMetric}」包含排行榜/排名相关标识，当前产品不提供成员排行榜（STAT-001）`,
        );
      }
    }
  }

  /**
   * 断言输出行不含排名/评分字段。
   */
  assertNoRankedOutput(rows: ReadonlyArray<Record<string, unknown>>): void {
    for (const row of rows) {
      if ('rank' in row || 'score' in row || 'percentile' in row) {
        throw new StatisticsCaliberError(
          'RANKED_OUTPUT_FORBIDDEN',
          '统计输出不得包含 rank/score/percentile 字段（STAT-001）',
        );
      }
    }
  }

  // -------------------------------------------------------------------------
  // 招新漏斗
  // -------------------------------------------------------------------------

  /**
   * 普通招新漏斗分阶段统计（STAT-001）。
   * 只适用于普通招新；联合活动漏斗经 JointActivityStatisticsQuery 单独查询。
   */
  recruitmentFunnel(
    facts: ReadonlyArray<NormalFunnelFact>,
    filters?: StatisticsFilters,
  ): {
    stages: FunnelStageView;
    orderedChoices: FunnelChoiceStats;
    adjustment: FunnelAdjustmentStats;
  } {
    const filtered = filters ? facts.filter((f) => matchesFunnel(f, filters)) : facts;

    const stages: FunnelStageView = {
      applied: filtered.length,
      attendedInterview: filtered.filter((f) => f.attendedInterview).length,
      invited: filtered.filter((f) => f.invitedAt !== null).length,
      invitationAccepted: filtered.filter((f) => f.invitationAcceptedAt !== null).length,
    };

    const withChoices = filtered.filter((f) => f.orderedChoiceCount > 0);
    const orderedChoices: FunnelChoiceStats = {
      applicantsWithChoices: withChoices.length,
      totalChoiceCount: withChoices.reduce((s, f) => s + f.orderedChoiceCount, 0),
    };

    const adjustment: FunnelAdjustmentStats = {
      accepts: filtered.filter((f) => f.acceptsAdjustment === true).length,
      declines: filtered.filter((f) => f.acceptsAdjustment === false).length,
      unspecified: filtered.filter((f) => f.acceptsAdjustment === null).length,
    };

    return { stages, orderedChoices, adjustment };
  }

  // -------------------------------------------------------------------------
  // 联合活动结论统计
  // -------------------------------------------------------------------------

  /**
   * 联合活动结论统计（STAT-001/STAT-002）。
   * - 参与方可见各社团结论统计，不做小样本模糊化；
   * - 传入的事实必须属于同一 jointActivityId；多活动混合抛出 MIXED_SCOPE_CALIBER。
   */
  jointConclusionStats(
    facts: ReadonlyArray<JointConclusionFact>,
    filters?: StatisticsFilters,
  ): JointConclusionStatsView {
    if (facts.length > 0) {
      const ids = new Set(facts.map((f) => f.jointActivityId));
      if (ids.size > 1) {
        throw new StatisticsCaliberError(
          'MIXED_SCOPE_CALIBER',
          `联合活动结论统计一次只能处理一个活动，发现 ${ids.size} 个：${[...ids].join(', ')}`,
        );
      }
    }

    const filtered = filters ? facts.filter((f) => matchesJointConclusion(f, filters)) : facts;

    const byClub = new Map<
      string,
      { id: string; name: string | null; accepted: number; rejected: number; pending: number }
    >();
    for (const f of filtered) {
      const entry = byClub.get(f.clubId) ?? {
        id: f.clubId,
        name: f.clubName ?? null,
        accepted: 0,
        rejected: 0,
        pending: 0,
      };
      if (f.conclusion === 'accepted') entry.accepted += 1;
      else if (f.conclusion === 'rejected') entry.rejected += 1;
      else entry.pending += 1;
      byClub.set(f.clubId, entry);
    }

    return {
      participantsExact: true,
      byClub: [...byClub.values()].map((e) => ({
        clubId: e.id,
        clubName: e.name,
        total: e.accepted + e.rejected + e.pending,
        accepted: e.accepted,
        rejected: e.rejected,
        pending: e.pending,
      })),
    };
  }

  // -------------------------------------------------------------------------
  // 趋势计算（按学年对比）
  // -------------------------------------------------------------------------

  /**
   * 成员趋势分桶过滤：应用与 `uniqueStudentCount` 一致的 `departmentId` 口径，
   * 但保留全部学年桶（不应用 `academicYear`），以便与前一年度对比趋势。
   * 过滤谓词收敛到领域层单一实现，查询用例不再内联复制，避免口径漂移（STAT-001）。
   */
  filterMembershipForTrend(
    facts: ReadonlyArray<MembershipFact>,
    filters: StatisticsFilters | undefined,
  ): MembershipFact[] {
    return facts.filter((f) => {
      if (!filters) return true;
      if (filters.departmentId && f.departmentId !== filters.departmentId) return false;
      return true;
    });
  }

  /**
   * 录取历史趋势分桶过滤：按 `scope` + `departmentId`/`timeRange` 口径过滤，
   * 保留全部学年桶（不应用 `academicYear`），用于与前一年度对比趋势。
   * 与 `splitAdmissionHistoryAndCurrent` 中的历史口径一致（STAT-001）。
   */
  filterAdmissionForTrend(
    facts: ReadonlyArray<AdmissionAcceptanceFact>,
    scope: StatScopeKind,
    filters: StatisticsFilters | undefined,
  ): AdmissionAcceptanceFact[] {
    return facts.filter((f) => {
      if (f.scope !== scope) return false;
      if (!filters) return true;
      if (filters.departmentId && f.departmentId !== filters.departmentId) return false;
      if (filters.timeRange) {
        if (f.acceptedAt < filters.timeRange.from) return false;
        if (f.acceptedAt > filters.timeRange.to) return false;
      }
      return true;
    });
  }

  /**
   * 计算当前值 vs 前一年学年值的趋势。前一年数据缺失则 flat/0。
   *
   * 业务意图说明（零基线语义）：前一年度桶存在但值为 0 时，同样视为
   * 无趋势（flat/0），即「零基线不参与涨跌判定」。这样避免从 0 增长到
   * 任意正数都被判为 up 而放大差异；如需如实反映从 0 的增长，可在上层
   * 显式构造 yearBuckets 时处理（此处统一按零基线视为无趋势）。
   */
  computeTrend(
    currentAcademicYear: string | undefined,
    currentValue: number,
    yearBuckets: Map<string, number>,
  ): { trend: 'up' | 'flat' | 'down'; trendValue: number } {
    if (currentAcademicYear === undefined) {
      return { trend: 'flat', trendValue: 0 };
    }
    const prev = previousAcademicYear(currentAcademicYear);
    if (prev === null) return { trend: 'flat', trendValue: 0 };
    const prevValue = yearBuckets.get(prev);
    if (prevValue === undefined || prevValue === 0) return { trend: 'flat', trendValue: 0 };

    const delta = currentValue - prevValue;
    if (delta > 0) return { trend: 'up', trendValue: delta };
    if (delta < 0) return { trend: 'down', trendValue: delta };
    return { trend: 'flat', trendValue: 0 };
  }

  // -------------------------------------------------------------------------
  // 导出字段基线
  // -------------------------------------------------------------------------

  /**
   * 返回指定数据集类型可导出的字段清单（统计口径 = 导出口径，EXP-001）。
   */
  exportFieldBaseline(type: ExportDatasetType): readonly string[] {
    return EXPORT_FIELD_GROUPS[type];
  }

  /**
   * 在导出基线基础上 clamp 请求的字段集，返回允许清单与被拒绝清单。
   * - requested 未指定则返回全基线；
   * - 请求字段不在基线内（越权字段）自动剔除并列入 rejected；
   * - 绝不在导出中出现的字段（秘密标识、联系方式）即使请求也拒绝（EXP-002）。
   */
  clampExportFields(
    type: ExportDatasetType,
    requested?: readonly string[],
  ): { fields: readonly string[]; rejected: readonly string[] } {
    const baseline = this.exportFieldBaseline(type);
    const baselineSet = new Set(baseline);
    const rejected: string[] = [];

    if (requested === undefined || requested.length === 0) {
      return { fields: baseline, rejected: [] };
    }

    const fields = requested.filter((f) => {
      if (NEVER_EXPORT_FIELDS.has(f)) {
        rejected.push(f);
        return false;
      }
      if (!baselineSet.has(f)) {
        rejected.push(f);
        return false;
      }
      return true;
    });

    // 拒绝清单去重
    return { fields, rejected: [...new Set(rejected)] };
  }
}
