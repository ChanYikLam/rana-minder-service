import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { PermissionCalculator, type PermissionContext } from './permission-calculator';
import { BUILT_IN_TEMPLATES, PermissionCatalog } from '../models/permission-template';

const ctx: PermissionContext = {
  userId: 'u_b',
  positionGroups: [
    { group: { owner: 'club-acm', name: '人事组' }, clubId: 'club-acm-1', departmentId: null },
  ],
  bindings: [
    {
      positionGroup: { owner: 'club-acm', name: '人事组' },
      clubId: 'club-acm-1',
      templateId: BUILT_IN_TEMPLATES.PERSONNEL.id,
      templateVersion: 1,
    },
  ],
  businessGrants: [],
  isPlatformSuperAdmin: false,
};

describe('PermissionCalculator', () => {
  it('职位 Group 映射已发布模板 → 授予模板权限（GOV-007）', () => {
    const calc = new PermissionCalculator();
    const r = calc.calculate(ctx, 'club-acm-1');
    assert.ok(r.permissions.includes('club:appointment:manage'));
    assert.ok(r.permissions.includes('club:member:manage'));
    assert.ok(!r.permissions.includes(BUILT_IN_TEMPLATES.LEADER.permissions[0]));
  });

  it('该用户处于 leader 职位 → 可管理负责人事务（ORG-021）', () => {
    const calc = new PermissionCalculator();
    const leaderCtx: PermissionContext = {
      ...ctx,
      positionGroups: [
        {
          group: { owner: 'club-acm', name: '负责人组' },
          clubId: 'club-acm-1',
          departmentId: null,
        },
      ],
      bindings: [
        {
          positionGroup: { owner: 'club-acm', name: '负责人组' },
          clubId: 'club-acm-1',
          templateId: BUILT_IN_TEMPLATES.LEADER.id,
          templateVersion: 1,
        },
      ],
    };
    const r = calc.calculate(leaderCtx, 'club-acm-1');
    assert.ok(r.permissions.includes('club:transition:manage'));
    assert.ok(r.permissions.includes('club:config:manage'));
  });

  it('不同社团严格隔离（ORG-023）', () => {
    const calc = new PermissionCalculator();
    const r = calc.calculate(ctx, 'another-club');
    assert.equal(r.permissions.length, 0);
  });

  it('部门级模板权限范围始终受所在部门限制（ORG-035）', () => {
    const calc = new PermissionCalculator();
    const deptCtx: PermissionContext = {
      ...ctx,
      positionGroups: [
        {
          group: { owner: 'club-acm', name: '宣传部' },
          clubId: 'club-acm-1',
          departmentId: 'dept-pr',
        },
      ],
      bindings: [
        {
          positionGroup: { owner: 'club-acm', name: '宣传部' },
          clubId: 'club-acm-1',
          templateId: BUILT_IN_TEMPLATES.DEPARTMENT_HEAD.id,
          templateVersion: 1,
        },
      ],
    };
    const r = calc.calculate(deptCtx, 'club-acm-1');
    const source = r.sources.find((s) => s.permission === 'club:member:manage');
    assert.ok(source);
    assert.equal(source.scope, 'department');
    assert.equal(source.scopeId, 'dept-pr');
  });

  it('职位 Group 未映射已发布模板不授权（GOV-007）', () => {
    const calc = new PermissionCalculator();
    const noBinding: PermissionContext = { ...ctx, bindings: [] };
    const r = calc.calculate(noBinding, 'club-acm-1');
    assert.deepEqual(r.permissions, []);
  });

  it('平台超管权限仅来自独立超管映射（ORG-029）', () => {
    const calc = new PermissionCalculator();
    assert.deepEqual(calc.platformPermissions(ctx), []);
    const r = calc.platformPermissions({ ...ctx, isPlatformSuperAdmin: true });
    assert.ok(r.includes('platform:club:manage'));
    assert.deepEqual(r, [
      'platform:club:manage',
      'platform:config:manage',
      'platform:delete:execute',
      'platform:audit:view',
      'platform:export:execute',
    ]);
  });

  it('业务任务临授权限作为权限来源（ORG-035）', () => {
    const calc = new PermissionCalculator();
    const r = calc.calculate(
      {
        ...ctx,
        businessGrants: [
          {
            permission: PermissionCatalog.CLUB_INTERVIEW_EVALUATE,
            clubId: 'club-acm-1',
            departmentId: null,
          },
        ],
      },
      'club-acm-1',
    );
    assert.ok(r.permissions.includes('club:interview:evaluate'));
  });
});
