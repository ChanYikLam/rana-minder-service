/**
 * StatisticsSpecification 单测：覆盖 STAT-001/003 四组硬规则 + 导出基线一致性。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  StatisticsSpecification,
  StatisticsCaliberError,
  type MembershipFact,
  type AdmissionAcceptanceFact,
  type NormalFunnelFact,
  type JointConclusionFact,
  type ExportDatasetType,
  EXPORT_FIELD_GROUPS,
  EXPORT_DATASET_TYPES,
  CONTACT_FIELD_GROUPS,
} from './statistics-specification';

const spec = new StatisticsSpecification();

// ---------------------------------------------------------------------------
// 辅助工厂
// ---------------------------------------------------------------------------

function membership(
  userId: string,
  studentNo: string,
  deptId: string | null = 'dept-a',
  deptName: string | null = '技术部',
  year = '2025-2026',
): MembershipFact {
  return {
    userId,
    studentNo,
    departmentId: deptId,
    departmentName: deptName,
    positionId: null,
    academicYear: year,
  };
}

function admission(
  userId: string,
  studentNo: string,
  activityId: string,
  scope: 'normal' | 'joint' = 'normal',
  deptId: string | null = 'dept-a',
  deptName: string | null = '技术部',
  year = '2025-2026',
  activityName = '2025秋招',
): AdmissionAcceptanceFact {
  return {
    userId,
    studentNo,
    recruitmentActivityId: activityId,
    activityName,
    scope,
    acceptedAt: '2025-09-01',
    departmentId: deptId,
    departmentName: deptName,
    academicYear: year,
  };
}

function funnel(
  appId: string,
  applicantId: string,
  attended: boolean = false,
  invited: string | null = null,
  accepted: string | null = null,
  choices: number = 0,
  adjust: boolean | null = null,
  deptId: string | null = 'dept-a',
  deptName: string | null = '技术部',
): NormalFunnelFact {
  return {
    applicationId: appId,
    applicantId,
    appliedAt: '2025-06-01',
    departmentId: deptId,
    departmentName: deptName,
    attendedInterview: attended,
    invitedAt: invited,
    invitationAcceptedAt: accepted,
    orderedChoiceCount: choices,
    acceptsAdjustment: adjust,
  };
}

function jointConclusion(
  jointId: string,
  clubId: string,
  clubName: string | null,
  applicantId: string,
  conclusion: 'accepted' | 'rejected' | 'pending' = 'accepted',
): JointConclusionFact {
  return {
    jointActivityId: jointId,
    clubId,
    clubName,
    applicantId,
    departmentId: null,
    departmentName: null,
    conclusion,
    concludedAt: '2025-10-01',
  };
}

// ===========================================================================
// 1. 普通 / 联合 不混合
// ===========================================================================

describe('StatisticsSpecification — 普通/联合不混合', () => {
  it('assertScopeSeparated: normal vs joint 抛出 MIXED_SCOPE_CALIBER', () => {
    assert.throws(
      () => spec.assertScopeSeparated('normal', 'joint'),
      (e: StatisticsCaliberError) => e.reason === 'MIXED_SCOPE_CALIBER',
    );
    assert.throws(
      () => spec.assertScopeSeparated('joint', 'normal'),
      (e: StatisticsCaliberError) => e.reason === 'MIXED_SCOPE_CALIBER',
    );
  });

  it('assertScopeSeparated: 同口径不抛', () => {
    assert.doesNotThrow(() => spec.assertScopeSeparated('normal', 'normal'));
    assert.doesNotThrow(() => spec.assertScopeSeparated('joint', 'joint'));
  });

  it('splitAdmissionHistoryAndCurrent: 分别返回 normalTotal / jointTotal，无混总数', () => {
    const memberships = [membership('u1', 'S001', 'dept-a')];
    const history = [
      admission('u1', 'S001', 'act-1', 'normal'),
      admission('u1', 'S001', 'act-2', 'joint'),
      admission('u2', 'S002', 'act-1', 'normal'),
    ];
    const view = spec.splitAdmissionHistoryAndCurrent(history, memberships);
    // 历史含两个 normal + 一个 joint，但没有混合的 "totalAccepted" 既是 normal 又是 joint —— 提供的 totalAccepted 是总事件计数，但 normalTotal/jointTotal 分别列出
    assert.equal(view.admissionHistory.normalTotal, 2, 'normal 录取事件 2');
    assert.equal(view.admissionHistory.jointTotal, 1, 'joint 录取事件 1');
    assert.equal(
      view.admissionHistory.totalAccepted,
      3,
      'totalAccepted = 3 事件计数（非混合，只是总计数）',
    );
    assert.ok('currentMembers' in view, 'currentMembers 键存在');
  });

  it('recruitmentFunnel: 只消费 NormalFunnelFact（类型级；联合漏斗经单独查询）', () => {
    const facts = [funnel('a1', 'u1', true, '2025-06-10', '2025-06-15')];
    const { stages } = spec.recruitmentFunnel(facts);
    assert.equal(stages.applied, 1);
    assert.equal(stages.attendedInterview, 1);
    assert.equal(stages.invited, 1);
    assert.equal(stages.invitationAccepted, 1);
  });

  it('jointConclusionStats: 多活动混合抛出 MIXED_SCOPE_CALIBER', () => {
    const facts = [
      jointConclusion('joint-A', 'c1', 'C1', 'u1'),
      jointConclusion('joint-B', 'c1', 'C1', 'u2'),
    ];
    assert.throws(
      () => spec.jointConclusionStats(facts),
      (e: StatisticsCaliberError) => e.reason === 'MIXED_SCOPE_CALIBER',
    );
  });

  it('jointConclusionStats: 空数组不抛', () => {
    const view = spec.jointConclusionStats([]);
    assert.equal(view.byClub.length, 0);
    assert.ok(view.participantsExact);
  });
});

// ===========================================================================
// 2. 多部门去重
// ===========================================================================

describe('StatisticsSpecification — 多部门去重', () => {
  const memberships: MembershipFact[] = [
    membership('u1', 'S001', 'dept-tech', '技术部'), // S001 在两个部门
    membership('u1', 'S001', 'dept-prod', '产品部'),
    membership('u2', 'S002', 'dept-tech', '技术部'),
    membership('u3', 'S003', 'dept-prod', '产品部'),
  ];

  it('departmentDistribution: 每部门分别计数（多部门成员在每个部门都出现）', () => {
    const dist = spec.departmentDistribution(memberships);
    const tech = dist.find((d) => d.departmentId === 'dept-tech');
    const prod = dist.find((d) => d.departmentId === 'dept-prod');
    assert.ok(tech);
    assert.ok(prod);
    assert.equal(tech.memberCount, 2, '技术部 2 人（u1+u2）');
    assert.equal(prod.memberCount, 2, '产品部 2 人（u1+u3）');
  });

  it('uniqueStudentCount: 社团总数按学号去重 = 3', () => {
    assert.equal(spec.uniqueStudentCount(memberships), 3);
  });

  it('uniqueStudentCount: 空集合返回 0', () => {
    assert.equal(spec.uniqueStudentCount([]), 0);
  });

  it('uniqueStudentCount: 按 departmentId 筛选（与 departmentDistribution 口径一致）', () => {
    const ms = [
      membership('u1', 'S001', 'dept-a'),
      membership('u1', 'S001', 'dept-b'), // 多部门
      membership('u2', 'S002', 'dept-a'),
      membership('u3', 'S003', 'dept-b'),
    ];
    assert.equal(spec.uniqueStudentCount(ms, { departmentId: 'dept-a' }), 2);
    assert.equal(spec.uniqueStudentCount(ms, { departmentId: 'dept-b' }), 2);
  });

  it('departmentDistribution: 空集合返回空数组', () => {
    assert.equal(spec.departmentDistribution([]).length, 0);
  });
});

// ===========================================================================
// 2.5 趋势分桶过滤（收敛到领域层，避免查询用例内联复制）
// ===========================================================================

describe('StatisticsSpecification — 趋势分桶过滤', () => {
  it('filterMembershipForTrend: 应用 departmentId 口径、保留全部学年桶', () => {
    const ms: MembershipFact[] = [
      membership('u1', 'S001', 'dept-a', '技术部', '2024-2025'),
      membership('u1', 'S001', 'dept-a', '技术部', '2025-2026'),
      membership('u2', 'S002', 'dept-b', '产品部', '2024-2025'),
      membership('u3', 'S003', 'dept-a', '技术部', '2023-2024'),
    ];
    const scoped = spec.filterMembershipForTrend(ms, { departmentId: 'dept-a' });
    // dept-b 被过滤；academicYear 不被过滤（保留全部学年桶供趋势对比）
    assert.equal(scoped.length, 3);
    assert.ok(scoped.every((m) => m.departmentId === 'dept-a'));
    assert.deepEqual(
      new Set(scoped.map((m) => m.academicYear)),
      new Set(['2023-2024', '2024-2025', '2025-2026']),
    );
  });

  it('filterMembershipForTrend: 无 filters → 原样返回', () => {
    const ms: MembershipFact[] = [
      membership('u1', 'S001', 'dept-a', '技术部', '2024-2025'),
      membership('u2', 'S002', 'dept-b', '产品部', '2025-2026'),
    ];
    assert.equal(spec.filterMembershipForTrend(ms, undefined).length, 2);
  });

  it('filterAdmissionForTrend: 按 scope + departmentId/timeRange 过滤、保留全部学年桶', () => {
    const facts: AdmissionAcceptanceFact[] = [
      admission('u1', 'S001', 'act-1', 'normal', 'dept-a', '技术部', '2024-2025'),
      admission('u1', 'S001', 'act-1', 'joint', 'dept-a', '技术部', '2024-2025'),
      admission('u2', 'S002', 'act-1', 'normal', 'dept-b', '产品部', '2025-2026'),
      admission('u3', 'S003', 'act-1', 'normal', 'dept-a', '技术部', '2023-2024'),
    ];
    const scoped = spec.filterAdmissionForTrend(facts, 'normal', {
      departmentId: 'dept-a',
      timeRange: { from: '2023-01-01', to: '2026-12-31' },
    });
    // 仅保留 normal + dept-a；joint 与 dept-b 被过滤；全部学年桶保留
    assert.equal(scoped.length, 2);
    assert.ok(scoped.every((h) => h.scope === 'normal' && h.departmentId === 'dept-a'));
    assert.deepEqual(
      new Set(scoped.map((h) => h.academicYear)),
      new Set(['2023-2024', '2024-2025']),
    );
  });

  it('filterAdmissionForTrend: timeRange 过滤生效', () => {
    const a = admission('u1', 'S001', 'act-1', 'normal', 'dept-a', '技术部', '2024-2025');
    // 将 acceptedAt 设为 range 之外
    const outside = { ...a, acceptedAt: '2020-01-01' };
    const inside = { ...a, acceptedAt: '2025-09-01' };
    const scoped = spec.filterAdmissionForTrend([outside, inside], 'normal', {
      timeRange: { from: '2021-01-01', to: '2026-12-31' },
    });
    assert.equal(scoped.length, 1);
    assert.equal(scoped[0].acceptedAt, '2025-09-01');
  });
});

// ===========================================================================
// 3. 排行榜关闭
// ===========================================================================

describe('StatisticsSpecification — 排行榜关闭', () => {
  it('assertLeaderboardClosed: "leaderboard" 抛出 LEADERBOARD_FORBIDDEN', () => {
    assert.throws(
      () => spec.assertLeaderboardClosed('leaderboard'),
      (e: StatisticsCaliberError) => e.reason === 'LEADERBOARD_FORBIDDEN',
    );
  });

  it('assertLeaderboardClosed: "ranking" 抛出', () => {
    assert.throws(
      () => spec.assertLeaderboardClosed('show_ranking'),
      (e: StatisticsCaliberError) => e.reason === 'LEADERBOARD_FORBIDDEN',
    );
  });

  it('assertLeaderboardClosed: 普通度量名不抛', () => {
    assert.doesNotThrow(() => spec.assertLeaderboardClosed('current_members'));
    assert.doesNotThrow(() => spec.assertLeaderboardClosed('admission_history'));
    assert.doesNotThrow(() => spec.assertLeaderboardClosed('members'));
    assert.doesNotThrow(() => spec.assertLeaderboardClosed('departmentDistribution'));
  });

  it('assertLeaderboardClosed: "score" 大写也能命中', () => {
    assert.throws(
      () => spec.assertLeaderboardClosed('MyScoreBoard'),
      (e: StatisticsCaliberError) => e.reason === 'LEADERBOARD_FORBIDDEN',
    );
  });

  it('assertNoRankedOutput: 含 rank 字段的行抛出 RANKED_OUTPUT_FORBIDDEN', () => {
    assert.throws(
      () => spec.assertNoRankedOutput([{ userId: 'u1', rank: 1 }]),
      (e: StatisticsCaliberError) => e.reason === 'RANKED_OUTPUT_FORBIDDEN',
    );
  });

  it('assertNoRankedOutput: 不含排名字段不抛', () => {
    assert.doesNotThrow(() => spec.assertNoRankedOutput([{ userId: 'u1', studentNo: 'S001' }]));
  });
});

// ===========================================================================
// 4. 录取历史与当前成员分算
// ===========================================================================

describe('StatisticsSpecification — 录取历史与当前成员分算', () => {
  const memberships: MembershipFact[] = [
    membership('u1', 'S001', 'dept-a', '技术部'),
    membership('u2', 'S002', 'dept-a', '技术部'),
  ];

  it('已离开成员的录取历史仍在、当前成员排除', () => {
    // u1 仍在，u2 已离开但录取历史还在
    const history = [
      admission('u1', 'S001', 'rec-1', 'normal'),
      admission('u2', 'S002', 'rec-1', 'normal'),
    ];
    const current = memberships; // u1 在、u2 在
    // 先看全集
    const viewAll = spec.splitAdmissionHistoryAndCurrent(history, current);
    assert.equal(viewAll.admissionHistory.normalTotal, 2, '两人录取历史');
    assert.equal(viewAll.currentMembers.total, 2, '两人当前成员');
    // 模拟 u2 离开后——当前成员只剩 u1
    const currentAfter: MembershipFact[] = [membership('u1', 'S001', 'dept-a', '技术部')];
    const viewAfter = spec.splitAdmissionHistoryAndCurrent(history, currentAfter);
    assert.equal(viewAfter.admissionHistory.normalTotal, 2, '离开不改写录取历史');
    assert.equal(viewAfter.currentMembers.total, 1, '当前成员 1 人');
  });

  it('byActivity 聚合含 scope 标记', () => {
    const history = [
      admission('u1', 'S001', 'rec-1', 'normal'),
      admission('u2', 'S002', 'rec-1', 'joint'),
    ];
    const view = spec.splitAdmissionHistoryAndCurrent(history, memberships);
    const byAct = view.admissionHistory.byActivity;
    assert.ok(byAct.length >= 1);
    const rec1 = byAct.find((a) => a.recruitmentActivityId === 'rec-1');
    assert.ok(rec1);
    // rec-1 同时有 normal 和 joint；byActivity 会分别为 scope 拆开
    assert.equal(
      byAct.filter((a) => a.recruitmentActivityId === 'rec-1' && a.scope === 'normal').length,
      1,
    );
    assert.equal(
      byAct.filter((a) => a.recruitmentActivityId === 'rec-1' && a.scope === 'joint').length,
      1,
    );
  });
});

// ===========================================================================
// 5. 招新漏斗
// ===========================================================================

describe('StatisticsSpecification — 招新漏斗', () => {
  const facts: NormalFunnelFact[] = [
    funnel('a1', 'u1', true, '2025-06-10', '2025-06-15', 3, true, 'dept-tech', '技术部'), // 全流程
    funnel('a2', 'u2', true, '2025-06-11', null, 1, false), // 邀请未接受
    funnel('a3', 'u3', false, null, null, 2, null), // 未参加面试
    funnel('a4', 'u4', false, null, null, 0, null), // 无志愿
  ];

  const { stages, orderedChoices, adjustment } = spec.recruitmentFunnel(facts);

  it('阶段计数正确', () => {
    assert.equal(stages.applied, 4);
    assert.equal(stages.attendedInterview, 2);
    assert.equal(stages.invited, 2);
    assert.equal(stages.invitationAccepted, 1);
  });

  it('顺序志愿统计', () => {
    assert.equal(orderedChoices.applicantsWithChoices, 3, '有志愿的申请人 3');
    assert.equal(orderedChoices.totalChoiceCount, 6, '总志愿数 3+1+2=6');
  });

  it('服从调剂统计', () => {
    assert.equal(adjustment.accepts, 1);
    assert.equal(adjustment.declines, 1);
    assert.equal(adjustment.unspecified, 2);
  });
});

// ===========================================================================
// 6. 联合活动结论统计
// ===========================================================================

describe('StatisticsSpecification — 联合活动结论统计', () => {
  it('同一活动内按社团分组、精确值', () => {
    const facts = [
      jointConclusion('joint-A', 'c1', 'ACM', 'u1', 'accepted'),
      jointConclusion('joint-A', 'c1', 'ACM', 'u2', 'accepted'),
      jointConclusion('joint-A', 'c2', '设计社', 'u3', 'rejected'),
      jointConclusion('joint-A', 'c2', '设计社', 'u4', 'pending'),
    ];
    const view = spec.jointConclusionStats(facts);
    assert.ok(view.participantsExact);
    assert.equal(view.byClub.length, 2);

    const c1 = view.byClub.find((c) => c.clubId === 'c1');
    assert.ok(c1);
    assert.equal(c1.accepted, 2);
    assert.equal(c1.rejected, 0);
    assert.equal(c1.pending, 0);
    assert.equal(c1.total, 2);

    const c2 = view.byClub.find((c) => c.clubId === 'c2');
    assert.ok(c2);
    assert.equal(c2.accepted, 0);
    assert.equal(c2.rejected, 1);
    assert.equal(c2.pending, 1);
    assert.equal(c2.total, 2);
  });
});

// ===========================================================================
// 7. 导出字段基线
// ===========================================================================

describe('StatisticsSpecification — 导出字段基线', () => {
  const types = [...EXPORT_DATASET_TYPES];

  it('所有 EXPORT_DATASET_TYPES 都有对应字段基线', () => {
    for (const t of types) {
      const fields = spec.exportFieldBaseline(t);
      assert.ok(Array.isArray(fields), `${t} 应有字段清单`);
      assert.ok(fields.length > 0, `${t} 字段基线非空`);
    }
  });

  it('未请求子集 → 返回全基线', () => {
    const { fields, rejected } = spec.clampExportFields('club_summary');
    assert.equal(fields.length, EXPORT_FIELD_GROUPS.club_summary.length);
    assert.equal(rejected.length, 0);
  });

  it('请求子集 → 交集', () => {
    const { fields, rejected } = spec.clampExportFields('current_members', [
      'userId',
      'studentNo',
      'phone',
    ]);
    assert.ok(fields.includes('userId'));
    assert.ok(fields.includes('studentNo'));
    assert.ok(!fields.includes('phone'), 'phone 应被拒绝');
    assert.ok(rejected.includes('phone'), 'phone 在拒绝清单中');
  });

  it('越权字段（不在基线中）被拒绝并列入 rejected', () => {
    const { fields, rejected } = spec.clampExportFields('club_summary', [
      'metric',
      'nonexistent_field',
      'secretFlag',
    ]);
    assert.ok(fields.includes('metric'));
    assert.ok(!fields.includes('nonexistent_field'));
    assert.ok(!fields.includes('secretFlag'));
    assert.ok(rejected.length >= 2);
  });

  it('秘密标识永不出现在基线', () => {
    for (const t of types) {
      const baseline = spec.exportFieldBaseline(t);
      for (const f of baseline) {
        assert.ok(f !== 'secretFlag', `${t}: secretFlag 不应在基线`);
        assert.ok(f !== 'secretMark', `${t}: secretMark 不应在基线`);
        assert.ok(f !== 'idCard', `${t}: idCard 不应在基线`);
      }
    }
  });

  it('联系方式不在基线中（EXP-002）', () => {
    for (const t of types) {
      const baseline = spec.exportFieldBaseline(t);
      assert.ok(!baseline.includes('phone'), `${t}: phone 不应在基线`);
      assert.ok(!baseline.includes('email'), `${t}: email 不应在基线`);
    }
  });

  it('clampExportFields: 请求空数组 → 全基线', () => {
    const { fields, rejected } = spec.clampExportFields('admission_history', []);
    assert.equal(fields.length, EXPORT_FIELD_GROUPS.admission_history.length);
    assert.equal(rejected.length, 0);
  });

  it('clampExportFields: 拒绝 secretFlag 即使请求', () => {
    const { fields, rejected } = spec.clampExportFields('current_members', [
      'userId',
      'secretFlag',
    ]);
    assert.ok(fields.includes('userId'));
    assert.ok(!fields.includes('secretFlag'));
    assert.ok(rejected.includes('secretFlag'));
  });
});

// ===========================================================================
// 7.1 联系方式显式勾选与秘密标识（5.4.3，EXP-002/EXP-003，R2/R4）
// ===========================================================================

describe('StatisticsSpecification — 联系方式勾选与秘密标识（EXP-002/EXP-003）', () => {
  const types = [...EXPORT_DATASET_TYPES];
  /** 仅人员行数据集存在联系方式列；其余数据集即使勾选也无联系方式可放行 */
  const PERSON_ROW_DATASETS: ExportDatasetType[] = ['current_members', 'admission_history'];

  it('CONTACT_FIELD_GROUPS：仅 current_members/admission_history 含 phone/email，其余为空', () => {
    for (const t of types) {
      if (PERSON_ROW_DATASETS.includes(t)) {
        assert.deepEqual(CONTACT_FIELD_GROUPS[t], ['phone', 'email']);
      } else {
        assert.deepEqual(CONTACT_FIELD_GROUPS[t], [], `${t} 不应有联系方式列`);
      }
    }
  });

  it('默认不导出（R2）：未勾选 includeContact 时请求 phone/email → 剔除并列入 rejected', () => {
    for (const t of PERSON_ROW_DATASETS) {
      const { fields, rejected } = spec.clampExportFields(t, [
        ...EXPORT_FIELD_GROUPS[t].slice(0, 2),
        'phone',
        'email',
      ]);
      assert.ok(!fields.includes('phone'), `${t}: phone 默认不导出`);
      assert.ok(!fields.includes('email'), `${t}: email 默认不导出`);
      assert.ok(rejected.includes('phone'));
      assert.ok(rejected.includes('email'));
    }
  });

  it('默认不导出（R2）：opts 显式传 includeContact=false 与缺省行为一致', () => {
    const a = spec.clampExportFields('current_members', ['userId', 'phone'], {
      includeContact: false,
    });
    const b = spec.clampExportFields('current_members', ['userId', 'phone']);
    assert.deepEqual(a, b);
    assert.ok(a.rejected.includes('phone'));
  });

  it('显式勾选（R2）：includeContact=true → phone/email 进入有效基线并可被保留', () => {
    for (const t of PERSON_ROW_DATASETS) {
      const { fields, rejected } = spec.clampExportFields(
        t,
        [...EXPORT_FIELD_GROUPS[t].slice(0, 2), 'phone', 'email'],
        { includeContact: true },
      );
      assert.ok(fields.includes('phone'), `${t}: 勾选后 phone 可导出`);
      assert.ok(fields.includes('email'), `${t}: 勾选后 email 可导出`);
      assert.deepEqual(rejected, []);
    }
  });

  it('勾选但非人员行数据集：club_summary 请求 phone/email 仍拒绝（无联系方式列）', () => {
    const { fields, rejected } = spec.clampExportFields('club_summary', ['metric', 'phone'], {
      includeContact: true,
    });
    assert.deepEqual(fields, ['metric']);
    assert.ok(rejected.includes('phone'));
  });

  it('requested 缺省 + includeContact=true → 全基线 + 联系方式字段（人员行数据集）', () => {
    const { fields, rejected } = spec.clampExportFields('current_members', undefined, {
      includeContact: true,
    });
    assert.equal(fields.length, EXPORT_FIELD_GROUPS.current_members.length + 2);
    assert.ok(fields.includes('phone'));
    assert.ok(fields.includes('email'));
    assert.deepEqual(rejected, []);
    // 未勾选时同参数返回纯默认基线（向后兼容）
    const plain = spec.clampExportFields('current_members');
    assert.deepEqual(plain.fields, EXPORT_FIELD_GROUPS.current_members);
    assert.deepEqual(plain.rejected, []);
  });

  it('秘密标识永不导出（R4）：password/token/apiKey 等即使勾选联系方式也一律拒绝', () => {
    const secrets = [
      'idCard',
      'secretFlag',
      'internalNote',
      'secretMark',
      'password',
      'secret',
      'token',
      'accessToken',
      'refreshToken',
      'apiKey',
      'captcha',
      'verificationCode',
      'internalSecretId',
    ];
    for (const opts of [undefined, { includeContact: true }] as const) {
      const { fields, rejected } = spec.clampExportFields(
        'current_members',
        ['userId', ...secrets],
        opts,
      );
      assert.deepEqual(fields, ['userId']);
      for (const s of secrets) {
        assert.ok(rejected.includes(s), `秘密标识 ${s} 必须进入拒绝清单（EXP-002）`);
      }
    }
  });

  it('秘密标识不出现在任何有效基线（含勾选联系方式后的全基线）', () => {
    const forbidden = new Set(['password', 'token', 'apiKey', 'captcha', 'verificationCode']);
    for (const t of types) {
      for (const opts of [undefined, { includeContact: true }] as const) {
        const baseline = spec.exportFieldBaseline(t, opts);
        for (const f of baseline) {
          assert.ok(!forbidden.has(f), `${t}: ${f} 不应出现在有效基线`);
          assert.ok(f !== 'idCard' && f !== 'secretFlag', `${t}: 秘密标识不得入基线`);
        }
      }
    }
  });

  it('未知字段仍被拒绝（勾选与否均不影响越权字段剔除路径）', () => {
    const a = spec.clampExportFields('current_members', ['userId', 'unknownField']);
    const b = spec.clampExportFields('current_members', ['userId', 'unknownField'], {
      includeContact: true,
    });
    assert.ok(a.rejected.includes('unknownField'));
    assert.ok(b.rejected.includes('unknownField'));
    // 请求子集模式下未请求 phone/email，勾选与否都不改变保留结果
    assert.deepEqual(a.fields, ['userId']);
    assert.deepEqual(b.fields, ['userId']);
  });
});

// ===========================================================================
// 8. 筛选条件
// ===========================================================================

describe('StatisticsSpecification — 筛选条件', () => {
  it('departmentDistribution 按部门筛选', () => {
    const memberships = [
      membership('u1', 'S001', 'dept-a', 'A部'),
      membership('u1', 'S001', 'dept-b', 'B部'),
      membership('u2', 'S002', 'dept-a', 'A部'),
    ];
    const dist = spec.departmentDistribution(memberships, { departmentId: 'dept-a' });
    assert.equal(dist.length, 1);
    assert.equal(dist[0].memberCount, 2);
  });

  it('splitAdmissionHistoryAndCurrent 按学年和时间范围筛选', () => {
    const history = [
      admission('u1', 'S001', 'act-1', 'normal', 'dept-a', 'A部', '2024-2025', '秋招'),
      admission('u2', 'S002', 'act-1', 'normal', 'dept-a', 'A部', '2025-2026', '春招'),
    ];
    const memberships = [
      membership('u1', 'S001', 'dept-a', 'A部', '2024-2025'),
      membership('u2', 'S002', 'dept-a', 'A部', '2025-2026'),
    ];
    const view = spec.splitAdmissionHistoryAndCurrent(history, memberships, {
      academicYear: '2024-2025',
    });
    assert.equal(view.admissionHistory.normalTotal, 1);
    assert.equal(view.currentMembers.total, 1);
  });
});
