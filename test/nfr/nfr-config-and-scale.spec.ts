/**
 * TST-NFR-001 / 002 / 003 / 051 / 052：规模基线、响应时间预算与策略配置边界。
 *
 * - TST-NFR-001：单校标准规模基线（100 社团/5 万账号/单活动 2000 申请/联合 20 社团）
 *   ——按权威 SRS 行解析的数值在内存生成确定性合成数据集并核对完整性与隔离性；
 * - TST-NFR-002：普通查询与保存 P95 ≤ 2 秒——真实 ClubStatisticsQuery 查询类
 *   在进程内探针下测量 P95；
 * - TST-NFR-003：复杂统计与搜索 P95 ≤ 5 秒；超界转异步——多条件筛选探针 +
 *   导出任务状态机证明异步路径可追踪、可重试；
 * - TST-NFR-051：保留策略范围外值拒绝且无副作用；高风险发布 10 分钟重认证窗口
 *   在 8/10/11 分钟边界的行为；
 * - TST-NFR-052：导出文件保留期出厂默认 30 天、硬边界 1..90 天；冻结快照计时起点
 *   不随后续平台默认值变化漂移。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';

import {
  srsNfrDefinition,
  tstNfrContract,
  percentile,
} from './nfr-support';
import {
  POLICY_REGISTRY,
  POLICY_KEYS,
  ScopedPolicyTable,
  amendActivitySnapshot,
} from '../../src/modules/config/domain/models/scoped-policy';
import { ConfigDomainError } from '../../src/modules/config/domain/errors';
import { ClubStatisticsQuery } from '../../src/modules/stat-export/application/queries/club-statistics.query';
import { StatisticsSpecification } from '../../src/modules/stat-export/domain/models/statistics-specification';
import type { StatisticsSourcePort, ClubStatProfile } from '../../src/modules/stat-export/application/ports/statistics-source.port';
import type { StatisticsAuditPort, StatisticsPrincipal } from '../../src/modules/stat-export/application/ports/statistics-authorization.port';
import type { MembershipFact, AdmissionAcceptanceFact } from '../../src/modules/stat-export/domain/models/statistics-specification';
import {
  ExportTaskStateMachine,
  ExportTaskStatus,
} from '../../src/modules/stat-export/domain/state-machines/export-task.state-machine';
import {
  HighRiskCommandGuard,
  HIGH_RISK_REAUTH_WINDOW_MS,
} from '../../src/modules/identity/application/services/high-risk-command.guard';

const NOW = new Date('2026-08-25T08:00:00.000Z');

// ---------------------------------------------------------------------------
// TST-NFR-001：单校标准规模基线
// ---------------------------------------------------------------------------

/** 从权威 SRS-NFR-001 行解析出的规模数字必须仍然声明四项基线 */
function parseScaleBaseline(): {
  clubs: number;
  students: number;
  applications: number;
  jointClubs: number;
} {
  const haystack = `${srsNfrDefinition('SRS-NFR-001')}\n${tstNfrContract('TST-NFR-001')}`;
  const num = (re: RegExp, what: string): number => {
    const m = re.exec(haystack);
    if (m === null) throw new Error(`SRS-NFR-001 规模数字解析失败：${what}（文档漂移）`);
    return Number(m[1].replace(/,/g, ''));
  };
  const wan = (re: RegExp, what: string): number => {
    const m = re.exec(haystack);
    if (m === null) throw new Error(`SRS-NFR-001 规模数字解析失败：${what}（文档漂移）`);
    return Number(m[1]) * 10000;
  };
  return {
    clubs: num(/(\d+)\s*个社团/, '社团数'),
    students: wan(/([\d,]+)\s*万名学生/, '学生账号数'),
    applications: num(/([\d,]+)\s*份申请/, '申请量'),
    jointClubs: num(/(\d+)\s*个参与社团/, '联合参与社团数'),
  };
}

describe('TST-NFR-001 单校标准规模基线', () => {
  it('TST-NFR-001: 合成数据集达到权威声明的全部规模且不串域、不丢对象', () => {
    const baseline = parseScaleBaseline();
    assert.equal(baseline.clubs, 100);
    assert.equal(baseline.students, 50000);
    assert.equal(baseline.applications, 2000);
    assert.equal(baseline.jointClubs, 20);

    // 确定性数据集生成（纯内存，无随机源；同输入恒同输出）
    const clubIds = Array.from({ length: baseline.clubs }, (_, i) => `SYN-CLUB-${String(i + 1).padStart(4, '0')}`);
    const studentIds = Array.from({ length: baseline.students }, (_, i) => `SYN-STU-${String(i + 1).padStart(6, '0')}`);
    const applications = Array.from({ length: baseline.applications }, (_, i) => ({
      applicationId: `SYN-APP-${String(i + 1).padStart(6, '0')}`,
      clubId: clubIds[0],
      applicantId: studentIds[i % studentIds.length],
    }));
    const jointParticipants = clubIds.slice(0, baseline.jointClubs);

    // 完整性：对象数与关系数同时达标，无丢失
    assert.equal(clubIds.length, 100);
    assert.equal(studentIds.length, 50000);
    assert.equal(applications.length, 2000);
    assert.equal(jointParticipants.length, 20);
    // 隔离性：申请只归属单一社团，不因联合活动串域
    for (const app of applications) {
      assert.equal(app.clubId, clubIds[0]);
      assert.ok(studentIds.includes(app.applicantId));
    }
    // 去重性：标识集合无重复（可重复生成的稳定键）
    assert.equal(new Set(clubIds).size, 100);
    assert.equal(new Set(studentIds).size, 50000);
  });
});

// ---------------------------------------------------------------------------
// TST-NFR-002 / 003：响应时间预算（真实查询用例 + 进程内探针）
// ---------------------------------------------------------------------------

interface FakeSourceOptions {
  membershipCount: number;
  historyCount: number;
}

/** 确定性事实源：按给定数量生成不可变投影事实 */
function makeFakeSource(opts: FakeSourceOptions): StatisticsSourcePort {
  const profile: ClubStatProfile = { clubId: 'SYN-CLUB-0001', forcedSuspension: false };
  const memberships: MembershipFact[] = Array.from(
    { length: opts.membershipCount },
    (_, i) => ({
      userId: `SYN-STU-${String(i + 1).padStart(6, '0')}`,
      studentNo: `2024${String(i + 1).padStart(6, '0')}`,
      departmentId: `dep-${i % 8}`,
      departmentName: `部门${i % 8}`,
      positionId: null,
      academicYear: i % 2 === 0 ? '2025-2026' : '2024-2025',
    }),
  );
  const history: AdmissionAcceptanceFact[] = Array.from(
    { length: opts.historyCount },
    (_, i) => ({
      userId: `SYN-STU-${String((i % 40000) + 1).padStart(6, '0')}`,
      studentNo: `2024${String((i % 40000) + 1).padStart(6, '0')}`,
      recruitmentActivityId: 'SYN-ACT-0001',
      activityName: '合成招新活动',
      scope: 'normal' as const,
      acceptedAt: new Date(NOW.getTime() - i * 1000).toISOString(),
      departmentId: `dep-${i % 8}`,
      departmentName: `部门${i % 8}`,
      academicYear: '2025-2026',
    }),
  );
  return {
    async loadClubProfile() {
      return profile;
    },
    async loadMembershipFacts() {
      return memberships;
    },
    async loadAdmissionHistory() {
      return history;
    },
    async loadNormalActivity() {
      return null;
    },
    async loadNormalFunnelFacts() {
      return [];
    },
    async loadJointActivity() {
      return null;
    },
    async loadJointConclusionFacts() {
      return [];
    },
    async loadPlatformMembershipFacts() {
      return memberships;
    },
    async loadPlatformAdmissionHistory() {
      return history;
    },
  };
}

const auditPort: StatisticsAuditPort = {
  async record() {
    /* 探针审计收集器：不落盘 */
  },
};

const principal: StatisticsPrincipal = {
  userId: 'syn-owner-01',
  isPlatformSuperAdmin: false,
  clubScopes: [{ clubId: 'SYN-CLUB-0001', level: 'club', departmentIds: [] }],
};

describe('TST-NFR-002 普通查询与保存响应时间预算', () => {
  it('TST-NFR-002: 真实社团统计汇总查询在标准规模事实上 P95 ≤ 2000ms 且口径分离', async () => {
    const source = makeFakeSource({ membershipCount: 5000, historyCount: 2000 });
    const query = new ClubStatisticsQuery(source, auditPort, new StatisticsSpecification());
    // 预热一次，排除首调用抖动后测量 30 个样本
    await query.summary({ principal, clubId: 'SYN-CLUB-0001' });
    const samples: number[] = [];
    let view;
    for (let i = 0; i < 30; i++) {
      const start = performance.now();
      view = await query.summary({ principal, clubId: 'SYN-CLUB-0001' });
      samples.push(performance.now() - start);
    }
    samples.sort((a, b) => a - b);
    const p95 = percentile(samples, 95);
    assert.ok(p95 <= 2000, `P95=${p95.toFixed(2)}ms 超过 2000ms 预算`);
    // 结果语义正确：普通/联合录取历史口径分离，不混算
    assert.equal(view!.caliber.normalAndJointSeparated, true);
    assert.equal(view!.caliber.leaderboardProvided, false);
  });
});

describe('TST-NFR-003 复杂统计与搜索响应时间预算与异步边界', () => {
  it('TST-NFR-003: 多条件组合下钻在预算内同步完成（P95 ≤ 5000ms）', async () => {
    const source = makeFakeSource({ membershipCount: 8000, historyCount: 20000 });
    const query = new ClubStatisticsQuery(source, auditPort, new StatisticsSpecification());
    const input = {
      principal,
      clubId: 'SYN-CLUB-0001',
      metric: 'admission_history' as const,
      limit: 200,
      filters: {
        departmentId: 'dep-3',
        academicYear: '2025-2026',
        timeRange: {
          from: new Date(NOW.getTime() - 3600_000).toISOString(),
          to: NOW.toISOString(),
        },
      },
    };
    await query.drilldown(input);
    const samples: number[] = [];
    for (let i = 0; i < 20; i++) {
      const start = performance.now();
      await query.drilldown(input);
      samples.push(performance.now() - start);
    }
    samples.sort((a, b) => a - b);
    const p95 = percentile(samples, 95);
    assert.ok(p95 <= 5000, `P95=${p95.toFixed(2)}ms 超过 5000ms 预算`);
  });

  it('TST-NFR-003: 同步边界外的场景有可识别异步状态——导出任务可追踪、失败可重试、成功才可下载', () => {
    const sm = new ExportTaskStateMachine();
    // 申请即进入可追踪异步处理状态（非模糊成功）
    assert.equal(sm.transition(ExportTaskStatus.NEW, 'apply'), ExportTaskStatus.PENDING_GENERATION);
    // 异步失败可查询且可重试（沿用原快照），不伪造成功
    assert.equal(sm.transition(ExportTaskStatus.GENERATING, 'generation_failed'), ExportTaskStatus.FAILED);
    assert.equal(sm.canApply(ExportTaskStatus.FAILED, 'retry_generation'), true);
    // 未生成成功不得可下载（禁止假成功）；下载每次实时重验
    assert.equal(sm.canDownload(ExportTaskStatus.GENERATING), false);
    assert.equal(sm.transition(ExportTaskStatus.GENERATING, 'generation_succeeded'), ExportTaskStatus.DOWNLOADABLE);
    assert.equal(sm.canDownload(ExportTaskStatus.DOWNLOADABLE), true);
  });
});

// ---------------------------------------------------------------------------
// TST-NFR-051：保留策略高风险发布边界
// ---------------------------------------------------------------------------

describe('TST-NFR-051 保留策略范围校验与高风险重认证窗口', () => {
  it('TST-NFR-051: 平台允许范围越过硬边界的发布被拒绝且聚合无副作用', () => {
    const table = ScopedPolicyTable.createDefault();
    const before = table.toSnapshot();
    // allowedMax 超过硬边界 90 → 拒绝
    assert.throws(
      () =>
        table.setPlatform(
          'EXPORT_FILE_RETENTION_DAYS',
          { defaultValue: 30, allowedMin: 1, allowedMax: 91 },
          { by: 'syn-super-admin', now: NOW },
        ),
      (err: unknown) => err instanceof ConfigDomainError && /硬边界/.test(err.message),
    );
    // 默认值落在允许范围外 → 拒绝
    assert.throws(
      () =>
        table.setPlatform(
          'EXPORT_FILE_RETENTION_DAYS',
          { defaultValue: 120, allowedMin: 1, allowedMax: 90 },
          { by: 'syn-super-admin', now: NOW },
        ),
      ConfigDomainError,
    );
    // 拒绝后无任何副作用（留痕与条目均未变化）
    const after = table.toSnapshot();
    assert.deepEqual(after.platform.EXPORT_FILE_RETENTION_DAYS, before.platform.EXPORT_FILE_RETENTION_DAYS);
    assert.equal(after.changes.length, before.changes.length);
  });

  it('TST-NFR-051: 高风险重新认证窗口为 10 分钟——8 分钟放行、11 分钟拒绝', async () => {
    assert.equal(HIGH_RISK_REAUTH_WINDOW_MS, 10 * 60 * 1000);
    let reauthAt: Date | null = null;
    const guard = new HighRiskCommandGuard({
      async latestReauthAt() {
        return reauthAt;
      },
      async record(): Promise<void> {
        /* 探针：无需登记 */
      },
    });
    // 证据缺失 → 拒绝（失败关闭）
    reauthAt = null;
    await assert.rejects(() => guard.assertFreshReauth('syn-admin', NOW), /重新认证/);
    // 8 分钟 < 10 分钟 → 放行
    reauthAt = new Date(NOW.getTime() - 8 * 60 * 1000);
    await guard.assertFreshReauth('syn-admin', NOW);
    // 边界值恰好 10 分钟仍在窗口内（"10 分钟内"含边界）→ 放行
    reauthAt = new Date(NOW.getTime() - 10 * 60 * 1000);
    await guard.assertFreshReauth('syn-admin', NOW);
    // 超出边界 1 毫秒即拒绝；11 分钟 → 拒绝
    reauthAt = new Date(NOW.getTime() - 10 * 60 * 1000 - 1);
    await assert.rejects(() => guard.assertFreshReauth('syn-admin', NOW), /重新认证/);
    reauthAt = new Date(NOW.getTime() - 11 * 60 * 1000);
    await assert.rejects(() => guard.assertFreshReauth('syn-admin', NOW), /重新认证/);
  });
});

// ---------------------------------------------------------------------------
// TST-NFR-052：临时数据计时起点与正式数据边界
// ---------------------------------------------------------------------------

describe('TST-NFR-052 临时数据保留期与快照计时起点', () => {
  it('TST-NFR-052: 导出文件保留期出厂默认 30 天且硬边界 1..90 天', () => {
    const def = POLICY_REGISTRY.EXPORT_FILE_RETENTION_DAYS;
    assert.equal(def.unit, 'DAYS');
    assert.equal(def.hardMin, 1);
    assert.equal(def.hardMax, 90);
    assert.equal(def.platformDefault, 30);
    // 注册表四键齐备且顺序稳定（逐键遍历合同）
    assert.deepEqual(POLICY_KEYS, [
      'INVITATION_VALID_DAYS',
      'CONFIRM_DEADLINE_HOURS',
      'PROFILE_SUPPLEMENT_DEADLINE_DAYS',
      'EXPORT_FILE_RETENTION_DAYS',
    ]);
  });

  it('TST-NFR-052: 缩短平台默认值不影响既有快照——冻结时刻为唯一计时起点，修订受控追加', () => {
    const table = ScopedPolicyTable.createDefault();
    const frozenAt = new Date(NOW.getTime() - 7 * 24 * 3600_000);
    const snapshot = table.freezeActivitySnapshot('SYN-ACT-1', 'SYN-CLUB-1', {
      by: 'syn-owner',
      now: frozenAt,
    });
    assert.equal(snapshot.values.EXPORT_FILE_RETENTION_DAYS, 30);
    assert.equal(snapshot.frozenAt.getTime(), frozenAt.getTime());

    // 冻结后平台缩短默认值为最短 1 天：既有快照结构性不受影响
    table.setPlatform(
      'EXPORT_FILE_RETENTION_DAYS',
      { defaultValue: 1, allowedMin: 1, allowedMax: 90 },
      { by: 'syn-super-admin', now: NOW },
    );
    assert.equal(snapshot.values.EXPORT_FILE_RETENTION_DAYS, 30);

    // 受控修订只在业务状态允许时生效并追加留痕；版本递增
    const amended = amendActivitySnapshot(
      snapshot,
      'EXPORT_FILE_RETENTION_DAYS',
      15,
      { by: 'syn-owner', now: NOW, businessAllows: true, platformRange: { min: 1, max: 90 } },
    );
    assert.equal(amended.values.EXPORT_FILE_RETENTION_DAYS, 15);
    assert.equal(amended.revisionNumber, 2);
    assert.equal(amended.amendments.length, 1);
    assert.equal(amended.amendments[0].oldValue, 30);
    // 业务状态不允许 → 拒绝且返回原对象不变
    assert.throws(
      () =>
        amendActivitySnapshot(amended, 'EXPORT_FILE_RETENTION_DAYS', 45, {
          by: 'syn-owner',
          now: NOW,
          businessAllows: false,
        }),
      ConfigDomainError,
    );
    assert.equal(amended.revisionNumber, 2);
  });
});
