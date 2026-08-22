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
  EXPORT_FIELD_GROUPS,
  EXPORT_DATASET_TYPES,
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
