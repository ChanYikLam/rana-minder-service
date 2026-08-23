/**
 * MemoryStatisticsAuthorizationPort + InMemoryStatisticsAuditPort 单测。
 *
 * 门禁测试：生产环境拒绝装配、缺 ORG_DEV_ACTOR_HEADER 拒绝。
 */

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  MemoryStatisticsAuthorizationPort,
  InMemoryStatisticsAuditPort,
  buildMemoryStatisticsAuthorizationSeedFromEnv,
  type MemoryStatisticsAuthorizationSeed,
} from './memory-statistics-access';

describe('buildMemoryStatisticsAuthorizationSeedFromEnv', () => {
  const saved = { ...process.env };

  afterEach(() => {
    // 恢复环境变量，避免影响其他用例
    process.env = { ...saved };
  });

  it('默认不设置 → 空种子（保持 fail-closed）', () => {
    delete process.env['ORG_DEV_STATS_DEMO'];
    delete process.env['ORG_DEV_STATS_DEMO_CLUBS'];
    delete process.env['ORG_DEV_STATS_DEMO_SUPER_ADMIN'];
    assert.deepEqual(buildMemoryStatisticsAuthorizationSeedFromEnv(), {});
  });

  it('ORG_DEV_STATS_DEMO=1 + clubs → 演示主体获得 club 级作用域', () => {
    process.env['ORG_DEV_STATS_DEMO'] = '1';
    process.env['ORG_DEV_STATS_DEMO_ACTOR'] = 'demo-user';
    process.env['ORG_DEV_STATS_DEMO_CLUBS'] = 'club-acm, club-design';
    const seed = buildMemoryStatisticsAuthorizationSeedFromEnv();
    assert.ok(seed.clubScopes);
    const scopes = seed.clubScopes['demo-user'];
    assert.equal(scopes.length, 2);
    assert.deepEqual(
      scopes.map((s) => s.clubId),
      ['club-acm', 'club-design'],
    );
    assert.equal(scopes[0].level, 'club');
  });

  it('ORG_DEV_STATS_DEMO=1 + superAdmin → 授予平台超管', () => {
    process.env['ORG_DEV_STATS_DEMO'] = '1';
    process.env['ORG_DEV_STATS_DEMO_SUPER_ADMIN'] = 'u_root';
    const seed = buildMemoryStatisticsAuthorizationSeedFromEnv();
    assert.deepEqual(seed.superAdminUserIds, ['u_root']);
  });
});

describe('MemoryStatisticsAuthorizationPort', () => {
  // 当前 env 已配 ORG_DEV_ACTOR_HEADER=1（.env.test）；装配成功
  const seed: MemoryStatisticsAuthorizationSeed = {
    superAdminUserIds: ['u_admin'],
    clubScopes: {
      u_leader: [{ clubId: 'club-acm', level: 'club' }],
      u_dept_head: [
        { clubId: 'club-acm', level: 'department', departmentIds: ['dept-tech'] },
        { clubId: 'club-design', level: 'club' },
      ],
      u_personnel: [{ clubId: 'club-acm', level: 'club' }],
    },
  };

  it('超级管理员解析正确', async () => {
    const port = new MemoryStatisticsAuthorizationPort(seed);
    const principal = await port.resolvePrincipal('u_admin');
    assert.equal(principal.isPlatformSuperAdmin, true);
    assert.equal(principal.clubScopes.length, 0);
  });

  it('社团负责人：club 级作用域', async () => {
    const port = new MemoryStatisticsAuthorizationPort(seed);
    const p = await port.resolvePrincipal('u_leader');
    assert.equal(p.isPlatformSuperAdmin, false);
    assert.equal(p.clubScopes.length, 1);
    assert.equal(p.clubScopes[0].level, 'club');
    assert.equal(p.clubScopes[0].clubId, 'club-acm');
  });

  it('部门负责人：department 级作用域', async () => {
    const port = new MemoryStatisticsAuthorizationPort(seed);
    const p = await port.resolvePrincipal('u_dept_head');
    assert.equal(p.isPlatformSuperAdmin, false);
    const acm = p.clubScopes.find((s) => s.clubId === 'club-acm');
    assert.ok(acm);
    assert.equal(acm.level, 'department');
    assert.deepEqual(acm.departmentIds, ['dept-tech']);
    const design = p.clubScopes.find((s) => s.clubId === 'club-design');
    assert.ok(design);
    assert.equal(design.level, 'club');
  });

  it('未登记用户 → 普通成员/申请人（空作用域）', async () => {
    const port = new MemoryStatisticsAuthorizationPort(seed);
    const p = await port.resolvePrincipal('u_unknown');
    assert.equal(p.isPlatformSuperAdmin, false);
    assert.equal(p.clubScopes.length, 0);
  });

  it('缺 ORG_DEV_ACTOR_HEADER → 装配失败', () => {
    const orig = process.env['ORG_DEV_ACTOR_HEADER'];
    process.env['ORG_DEV_ACTOR_HEADER'] = '';
    assert.throws(
      () => new MemoryStatisticsAuthorizationPort(seed),
      /须显式设置 ORG_DEV_ACTOR_HEADER=1/,
    );
    process.env['ORG_DEV_ACTOR_HEADER'] = orig;
  });
});

describe('InMemoryStatisticsAuditPort', () => {
  it('记录审计条目', async () => {
    const audit = new InMemoryStatisticsAuditPort();
    await audit.record({
      at: '2026-01-01T00:00:00Z',
      action: 'club_summary',
      principalId: 'u1',
      privileged: false,
      clubId: 'club-1',
      jointActivityId: null,
      outcome: 'allowed',
    });
    assert.equal(audit.entries.length, 1);
    assert.equal(audit.entries[0].action, 'club_summary');
  });

  it('clear 清空审计日志', async () => {
    const audit = new InMemoryStatisticsAuditPort();
    await audit.record({
      at: '2026-01-01T00:00:00Z',
      action: 'club_summary',
      principalId: 'u1',
      privileged: false,
      clubId: 'club-1',
      jointActivityId: null,
      outcome: 'allowed',
    });
    audit.clear();
    assert.equal(audit.entries.length, 0);
  });
});
