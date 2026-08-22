/**
 * JointActivityStatisticsQuery 单测（STAT-002 角色覆盖）。
 *
 * 角色覆盖：
 * - 参与方社团负责人：精确结论统计（含同活动中他社）；
 * - 参与方部门负责人：仅本部门结论；
 * - 非参与方社团：拒绝（不由此访问对方活动）；
 * - 普通成员/申请人：拒绝；
 * - 超级管理员：全活动可见 + 特权审计；
 * - 紧急停用参与方：撤权。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { StatisticsSpecification } from '../../domain/models/statistics-specification';
import { InMemoryStatisticsSource } from '../../infrastructure/in-memory-statistics-source';
import { InMemoryStatisticsAuditPort } from '../../infrastructure/memory-statistics-access';
import { JointActivityStatisticsQuery } from './joint-activity-statistics.query';
import { StatisticsAccessError } from '../statistics-errors';

function setupSource() {
  const source = new InMemoryStatisticsSource();
  source.seedClubProfile({ clubId: 'club-acm', forcedSuspension: false });
  source.seedClubProfile({ clubId: 'club-design', forcedSuspension: false });
  source.seedClubProfile({ clubId: 'club-other', forcedSuspension: false });

  // 联合活动：ACM + 设计社参与
  source.seedJointActivity({
    jointActivityId: 'joint-design-fair',
    participantClubIds: ['club-acm', 'club-design'],
  });

  source.seedJointConclusionFacts('joint-design-fair', [
    {
      jointActivityId: 'joint-design-fair',
      clubId: 'club-acm',
      clubName: 'ACM 社',
      applicantId: 'u1',
      departmentId: 'dept-tech',
      departmentName: '技术部',
      conclusion: 'accepted',
      concludedAt: '2025-10-01',
    },
    {
      jointActivityId: 'joint-design-fair',
      clubId: 'club-acm',
      clubName: 'ACM 社',
      applicantId: 'u2',
      departmentId: 'dept-prod',
      departmentName: '产品部',
      conclusion: 'accepted',
      concludedAt: '2025-10-01',
    },
    {
      jointActivityId: 'joint-design-fair',
      clubId: 'club-design',
      clubName: '设计社',
      applicantId: 'u3',
      departmentId: 'dept-art',
      departmentName: '美术部',
      conclusion: 'rejected',
      concludedAt: '2025-10-01',
    },
    {
      jointActivityId: 'joint-design-fair',
      clubId: 'club-design',
      clubName: '设计社',
      applicantId: 'u4',
      departmentId: 'dept-art',
      departmentName: '美术部',
      conclusion: 'pending',
      concludedAt: null,
    },
    {
      jointActivityId: 'joint-design-fair',
      clubId: 'club-acm',
      clubName: 'ACM 社',
      applicantId: 'u5',
      departmentId: 'dept-tech',
      departmentName: '技术部',
      conclusion: 'accepted',
      concludedAt: '2025-10-01',
    },
  ]);

  return source;
}

describe('JointActivityStatisticsQuery — 角色（STAT-002）', () => {
  it('参与方社团负责人：精确结论统计、含他社', async () => {
    const source = setupSource();
    const audit = new InMemoryStatisticsAuditPort();
    const query = new JointActivityStatisticsQuery(source, audit, new StatisticsSpecification());
    const view = await query.statistics({
      principal: {
        userId: 'u_acm_leader',
        isPlatformSuperAdmin: false,
        clubScopes: [{ clubId: 'club-acm', level: 'club', departmentIds: [] }],
      },
      jointActivityId: 'joint-design-fair',
    });
    assert.equal(view.jointActivityId, 'joint-design-fair');
    assert.equal(view.byClub.length, 2, '两个社团');
    assert.ok(view.exactValues);
    assert.ok(!view.smallSampleMaskingApplied);

    const acm = view.byClub.find((c) => c.clubId === 'club-acm');
    assert.ok(acm);
    assert.equal(acm.accepted, 3);
    assert.equal(acm.rejected, 0);
    assert.equal(acm.pending, 0);
    assert.equal(acm.total, 3);

    const design = view.byClub.find((c) => c.clubId === 'club-design');
    assert.ok(design);
    assert.equal(design.accepted, 0);
    assert.equal(design.rejected, 1);
    assert.equal(design.pending, 1);
    assert.equal(design.total, 2);
  });

  it('参与方部门负责人：仅本部门结论', async () => {
    const source = setupSource();
    const audit = new InMemoryStatisticsAuditPort();
    const query = new JointActivityStatisticsQuery(source, audit, new StatisticsSpecification());
    const view = await query.statistics({
      principal: {
        userId: 'u_acm_dept',
        isPlatformSuperAdmin: false,
        clubScopes: [{ clubId: 'club-acm', level: 'department', departmentIds: ['dept-tech'] }],
      },
      jointActivityId: 'joint-design-fair',
    });
    // 仅 tech 部门：u1 + u5 accepted
    const acm = view.byClub.find((c) => c.clubId === 'club-acm');
    assert.ok(acm);
    assert.equal(acm.accepted, 2);
    assert.equal(acm.rejected, 0);
    assert.equal(acm.total, 2);
    // 设计社的结论在部门负责人视角也可见（因为同活动但跨 club——仍可见其他社团总结论？STAT-002 参与方可见各社团结论统计）
    // 但部门负责人只按部门过滤自己的社团事实；其他社团事实全部展示（部门过滤只作用于自己社团的 fact）。
    // 注意 scopedFacts 只过滤该 user 部门的 facts，其他 club 的 facts 不受他部门限制
    const design = view.byClub.find((c) => c.clubId === 'club-design');
    assert.ok(design);
    assert.equal(design.total, 2);
  });

  it('非参与方社团：拒绝 IFC-ERR-003', async () => {
    const source = setupSource();
    const audit = new InMemoryStatisticsAuditPort();
    const query = new JointActivityStatisticsQuery(source, audit, new StatisticsSpecification());
    await assert.rejects(
      () =>
        query.statistics({
          principal: {
            userId: 'u_other_leader',
            isPlatformSuperAdmin: false,
            clubScopes: [{ clubId: 'club-other', level: 'club', departmentIds: [] }],
          },
          jointActivityId: 'joint-design-fair',
        }),
      (e: StatisticsAccessError) => e.code === 'IFC-ERR-003',
    );
  });

  it('普通成员/申请人拒', async () => {
    const source = setupSource();
    const audit = new InMemoryStatisticsAuditPort();
    const query = new JointActivityStatisticsQuery(source, audit, new StatisticsSpecification());
    await assert.rejects(
      () =>
        query.statistics({
          principal: { userId: 'u_member', isPlatformSuperAdmin: false, clubScopes: [] },
          jointActivityId: 'joint-design-fair',
        }),
      (e: StatisticsAccessError) => e.code === 'IFC-ERR-003',
    );
  });

  it('超级管理员：全活动可见 + 特权审计', async () => {
    const source = setupSource();
    const audit = new InMemoryStatisticsAuditPort();
    const query = new JointActivityStatisticsQuery(source, audit, new StatisticsSpecification());
    const view = await query.statistics({
      principal: { userId: 'u_admin', isPlatformSuperAdmin: true, clubScopes: [] },
      jointActivityId: 'joint-design-fair',
    });
    assert.equal(view.byClub.length, 2);
    const entry = audit.entries.find((e) => e.action === 'joint_activity_stats');
    assert.ok(entry);
    assert.ok(entry.privileged);
    assert.equal(entry.jointActivityId, 'joint-design-fair');
  });

  it('不存在的联合活动 → 404', async () => {
    const source = setupSource();
    const audit = new InMemoryStatisticsAuditPort();
    const query = new JointActivityStatisticsQuery(source, audit, new StatisticsSpecification());
    await assert.rejects(
      () =>
        query.statistics({
          principal: {
            userId: 'u_acm_leader',
            isPlatformSuperAdmin: false,
            clubScopes: [{ clubId: 'club-acm', level: 'club', departmentIds: [] }],
          },
          jointActivityId: 'nonexistent',
        }),
      (e: StatisticsAccessError) => e.code === 'IFC-ERR-015',
    );
  });

  it('紧急停用参与方：拒绝 IFC-ERR-006', async () => {
    const source = setupSource();
    source.seedClubProfile({ clubId: 'club-suspended', forcedSuspension: true });
    source.seedJointActivity({
      jointActivityId: 'joint-susp',
      participantClubIds: ['club-suspended', 'club-design'],
    });
    const audit = new InMemoryStatisticsAuditPort();
    const query = new JointActivityStatisticsQuery(source, audit, new StatisticsSpecification());
    await assert.rejects(
      () =>
        query.statistics({
          principal: {
            userId: 'u_susp_leader',
            isPlatformSuperAdmin: false,
            clubScopes: [{ clubId: 'club-suspended', level: 'club', departmentIds: [] }],
          },
          jointActivityId: 'joint-susp',
        }),
      (e: StatisticsAccessError) => e.code === 'IFC-ERR-006',
    );
  });
});
