/**
 * RecruitmentFunnelQuery 单测（STAT-002 角色覆盖）。
 *
 * 角色覆盖：
 * - 社团负责人/人事：全活动漏斗；
 * - 部门负责人：仅本部门申请者漏斗；
 * - 普通成员/申请人：拒绝；
 * - 跨活动隔离（非本社活动、联合活动作为普通漏斗查询）；
 * - 紧急停用撤权。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { StatisticsSpecification } from '../../domain/models/statistics-specification';
import { InMemoryStatisticsSource } from '../../infrastructure/in-memory-statistics-source';
import { InMemoryStatisticsAuditPort } from '../../infrastructure/memory-statistics-access';
import { RecruitmentFunnelQuery } from './recruitment-funnel.query';
import { StatisticsAccessError } from '../statistics-errors';

function setupSource() {
  const source = new InMemoryStatisticsSource();
  source.seedClubProfile({ clubId: 'club-acm', forcedSuspension: false });
  source.seedClubProfile({ clubId: 'club-other', forcedSuspension: false });

  // 普通招新活动
  source.seedNormalActivity({ activityId: 'rec-normal-1', clubId: 'club-acm', academicYear: '2025-2026' });

  // 漏斗事实
  source.seedFunnelFacts('rec-normal-1', [
    { applicationId: 'app-1', applicantId: 'u1', appliedAt: '2025-06-01', departmentId: 'dept-tech', departmentName: '技术部', attendedInterview: true, invitedAt: '2025-06-10', invitationAcceptedAt: '2025-06-15', orderedChoiceCount: 2, acceptsAdjustment: true },
    { applicationId: 'app-2', applicantId: 'u2', appliedAt: '2025-06-02', departmentId: 'dept-tech', departmentName: '技术部', attendedInterview: true, invitedAt: '2025-06-11', invitationAcceptedAt: null, orderedChoiceCount: 1, acceptsAdjustment: false },
    { applicationId: 'app-3', applicantId: 'u3', appliedAt: '2025-06-03', departmentId: 'dept-prod', departmentName: '产品部', attendedInterview: false, invitedAt: null, invitationAcceptedAt: null, orderedChoiceCount: 0, acceptsAdjustment: null },
  ]);

  return source;
}

describe('RecruitmentFunnelQuery — 角色（STAT-002）', () => {
  it('社团负责人：全活动漏斗', async () => {
    const source = setupSource();
    const audit = new InMemoryStatisticsAuditPort();
    const query = new RecruitmentFunnelQuery(source, audit, new StatisticsSpecification());
    const view = await query.funnel({
      principal: { userId: 'u_leader', isPlatformSuperAdmin: false, clubScopes: [{ clubId: 'club-acm', level: 'club', departmentIds: [] }] },
      clubId: 'club-acm',
      activityId: 'rec-normal-1',
    });
    assert.equal(view.activityId, 'rec-normal-1');
    assert.equal(view.stages.applied, 3);
    assert.equal(view.stages.attendedInterview, 2);
    assert.equal(view.stages.invited, 2);
    assert.equal(view.stages.invitationAccepted, 1);
    assert.ok(view.caliber.normalRecruitmentOnly);
  });

  it('部门负责人：仅本部门漏斗', async () => {
    const source = setupSource();
    const audit = new InMemoryStatisticsAuditPort();
    const query = new RecruitmentFunnelQuery(source, audit, new StatisticsSpecification());
    // 部门负责人仅技术部
    const view = await query.funnel({
      principal: { userId: 'u_dept', isPlatformSuperAdmin: false, clubScopes: [{ clubId: 'club-acm', level: 'department', departmentIds: ['dept-tech'] }] },
      clubId: 'club-acm',
      activityId: 'rec-normal-1',
    });
    // 仅 u1, u2（技术部），u3（产品部）不可见
    assert.equal(view.stages.applied, 2);
    assert.equal(view.stages.attendedInterview, 2);
    assert.equal(view.stages.invited, 2);
    assert.equal(view.stages.invitationAccepted, 1);
  });

  it('普通成员/申请人：拒绝 IFC-ERR-003', async () => {
    const source = setupSource();
    const audit = new InMemoryStatisticsAuditPort();
    const query = new RecruitmentFunnelQuery(source, audit, new StatisticsSpecification());
    await assert.rejects(
      () => query.funnel({
        principal: { userId: 'u_member', isPlatformSuperAdmin: false, clubScopes: [] },
        clubId: 'club-acm',
        activityId: 'rec-normal-1',
      }),
      (e: StatisticsAccessError) => e.code === 'IFC-ERR-003',
    );
  });

  it('非本社招新活动 → 404 拒绝', async () => {
    const source = setupSource();
    // club-other 没有 seed 任何活动
    const audit = new InMemoryStatisticsAuditPort();
    const query = new RecruitmentFunnelQuery(source, audit, new StatisticsSpecification());
    source.seedNormalActivity({ activityId: 'other-activity', clubId: 'club-other', academicYear: '2025-2026' });
    const principal = { userId: 'u_leader', isPlatformSuperAdmin: false, clubScopes: [{ clubId: 'club-acm', level: 'club' as const, departmentIds: [] as readonly string[] }] };
    // 活动存在但不是 club-acm 的
    await assert.rejects(
      () => query.funnel({ principal, clubId: 'club-acm', activityId: 'other-activity' }),
      (e: StatisticsAccessError) => e.code === 'IFC-ERR-015',
    );
  });

  it('不存在的活动 → 404', async () => {
    const source = setupSource();
    const audit = new InMemoryStatisticsAuditPort();
    const query = new RecruitmentFunnelQuery(source, audit, new StatisticsSpecification());
    const principal = { userId: 'u_leader', isPlatformSuperAdmin: false, clubScopes: [{ clubId: 'club-acm', level: 'club' as const, departmentIds: [] as readonly string[] }] };
    await assert.rejects(
      () => query.funnel({ principal, clubId: 'club-acm', activityId: 'nonexistent' }),
      (e: StatisticsAccessError) => e.code === 'IFC-ERR-015',
    );
  });

  it('紧急停用社团：拒绝 IFC-ERR-006', async () => {
    const source = setupSource();
    source.seedClubProfile({ clubId: 'club-suspended', forcedSuspension: true });
    source.seedNormalActivity({ activityId: 'susp-act', clubId: 'club-suspended', academicYear: '2025-2026' });
    const audit = new InMemoryStatisticsAuditPort();
    const query = new RecruitmentFunnelQuery(source, audit, new StatisticsSpecification());
    const principal = { userId: 'u_leader', isPlatformSuperAdmin: false, clubScopes: [{ clubId: 'club-suspended', level: 'club' as const, departmentIds: [] as readonly string[] }] };
    await assert.rejects(
      () => query.funnel({ principal, clubId: 'club-suspended', activityId: 'susp-act' }),
      (e: StatisticsAccessError) => e.code === 'IFC-ERR-006',
    );
  });
});
