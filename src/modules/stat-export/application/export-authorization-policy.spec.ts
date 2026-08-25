/**
 * 导出授权策略层独立专项单测（5.4.2，交叉检查验证资产）。
 *
 * 本文件直接对 export-authorization.policy.ts 的纯函数做边界场景单测，
 * 与 export-commands.spec.ts（经命令层间接覆盖）互补：
 * - 命令层覆盖"端到端流程"（申请→重试→删除→下载）；
 * - 本文件直击策略层纯函数的极端/边界分支，作为可复现的回归防线，
 *   使策略函数的授权/停用/重认证判定在单函数粒度上被显式锁定。
 *
 * 覆盖函数：
 * - authorizeBatchExportScope（5 类导出者批量导出收敛 + 类型穷尽保护）；
 * - authorizeContactOptIn（联系方式勾选闸门：3 类身份可勾选、成员仅本人个人副本、
 *   面试官一律禁止，5.4.3 EXP-002/EXP-003）；
 * - convergeJointExportScope（联合导出参与方边界、显式社团一致性）；
 * - authorizePersonalCopy（个人副本 5 类边界、target 缺省默认本人）；
 * - revalidateExportScope / revalidateExportScopeWithFacts（静态 + 归属回源）；
 * - assertNotSuspended（joint/club/department/personal 停用封锁）；
 * - assertFreshReauth（重认证新鲜度/伪造/过期/缺省）；
 * - 便捷主体工厂（platformSuperAdminPrincipal / clubLeaderPrincipal）。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { ExportPrincipal } from './ports/export-authorization.port';
import { InMemoryExportFactSource } from '../infrastructure/in-memory-export-fact-source';
import { MemoryExportReauthPort } from '../infrastructure/memory-export-access';
import { ExportError } from './errors';
import {
  authorizeBatchExportScope,
  authorizeContactOptIn,
  convergeJointExportScope,
  authorizePersonalCopy,
  revalidateExportScope,
  revalidateExportScopeWithFacts,
  assertNotSuspended,
  assertFreshReauth,
  assertPersonalCopyTargetInScope,
  platformSuperAdminPrincipal,
  clubLeaderPrincipal,
  SUPER_ADMIN_REAUTH_TTL_MS,
} from './export-authorization.policy';
import type { ExportScopeRevalidateInput } from './export-authorization.policy';

/** 断言抛出的 ExportError 错误码 */
function expectErrorCode(fn: () => void, code: ExportError['code']): void {
  assert.throws(fn, (err: unknown) => err instanceof ExportError && err.code === code);
}

function expectErrorCodeAsync(
  fn: () => Promise<unknown>,
  code: ExportError['code'],
): Promise<void> {
  return assert.rejects(fn(), (err: unknown) => err instanceof ExportError && err.code === code);
}

const DEPT_LEADER: ExportPrincipal = {
  userId: 'dept-1',
  kind: 'department_leader',
  clubScopes: [{ clubId: 'club-1', level: 'department', departmentIds: ['dept-A', 'dept-B'] }],
};
const CLUB_LEADER: ExportPrincipal = {
  userId: 'hr-1',
  kind: 'club_leader_hr',
  clubScopes: [{ clubId: 'club-1', level: 'club', departmentIds: [] }],
};
const CLUB_LEADER_DEPT_ONLY: ExportPrincipal = {
  userId: 'hr-dept',
  kind: 'club_leader_hr',
  clubScopes: [{ clubId: 'club-1', level: 'department', departmentIds: ['dept-A'] }],
};
const INTERVIEWER: ExportPrincipal = {
  userId: 'iv-1',
  kind: 'interviewer',
  clubScopes: [],
};
const MEMBER: ExportPrincipal = {
  userId: 'mem-1',
  kind: 'member_applicant',
  clubScopes: [],
};

describe('authorizeBatchExportScope 批量导出收敛（EXP-003）', () => {
  it('普通面试官：任何批量导出一律拒绝（IFC-ERR-003）', () => {
    expectErrorCode(
      () => authorizeBatchExportScope(INTERVIEWER, { kind: 'club', clubId: 'club-1' }),
      'IFC-ERR-003',
    );
    expectErrorCode(
      () => authorizeBatchExportScope(INTERVIEWER, { kind: 'platform' }),
      'IFC-ERR-003',
    );
  });

  it('普通成员/申请人：任何批量导出一律拒绝（IFC-ERR-003）', () => {
    expectErrorCode(
      () =>
        authorizeBatchExportScope(MEMBER, {
          kind: 'department',
          clubId: 'club-1',
          departmentId: 'dept-A',
        }),
      'IFC-ERR-003',
    );
  });

  it('部门负责人：导出全平台/整个社团 → 分别拒绝（IFC-ERR-003 / IFC-ERR-004）', () => {
    expectErrorCode(
      () => authorizeBatchExportScope(DEPT_LEADER, { kind: 'platform' }),
      'IFC-ERR-003',
    );
    expectErrorCode(
      () => authorizeBatchExportScope(DEPT_LEADER, { kind: 'club', clubId: 'club-1' }),
      'IFC-ERR-004',
    );
  });

  it('部门负责人：缺 clubId/departmentId → 校验错误（IFC-ERR-005）', () => {
    expectErrorCode(
      () => authorizeBatchExportScope(DEPT_LEADER, { kind: 'department' }),
      'IFC-ERR-005',
    );
  });

  it('部门负责人：请求导出部门但缺 departmentId → 校验错误（IFC-ERR-005）', () => {
    expectErrorCode(
      () => authorizeBatchExportScope(DEPT_LEADER, { kind: 'department', clubId: 'club-1' }),
      'IFC-ERR-005',
    );
  });

  it('部门负责人：无该社团作用域 → 拒绝（IFC-ERR-003）', () => {
    expectErrorCode(
      () =>
        authorizeBatchExportScope(DEPT_LEADER, {
          kind: 'department',
          clubId: 'club-other',
          departmentId: 'dept-A',
        }),
      'IFC-ERR-003',
    );
  });

  it('部门负责人：部门不在可导出集合 → 作用域不匹配（IFC-ERR-004）', () => {
    expectErrorCode(
      () =>
        authorizeBatchExportScope(DEPT_LEADER, {
          kind: 'department',
          clubId: 'club-1',
          departmentId: 'dept-X',
        }),
      'IFC-ERR-004',
    );
  });

  it('部门负责人：合法部门导出收敛为 department（privileged=false）', () => {
    const r = authorizeBatchExportScope(DEPT_LEADER, {
      kind: 'department',
      clubId: 'club-1',
      departmentId: 'dept-B',
    });
    assert.equal(r.kind, 'department');
    assert.deepEqual(r.departmentIds, ['dept-B']);
    assert.equal(r.privileged, false);
    assert.equal(r.jointActivityId, null);
  });

  it('社团负责人/人事：导出全平台 → 拒绝（IFC-ERR-003）', () => {
    expectErrorCode(
      () => authorizeBatchExportScope(CLUB_LEADER, { kind: 'platform' }),
      'IFC-ERR-003',
    );
  });

  it('社团负责人/人事：缺 clubId → 校验错误（IFC-ERR-005）', () => {
    expectErrorCode(() => authorizeBatchExportScope(CLUB_LEADER, { kind: 'club' }), 'IFC-ERR-005');
  });

  it('社团负责人/人事：无该社团作用域 → 拒绝（IFC-ERR-003）', () => {
    expectErrorCode(
      () => authorizeBatchExportScope(CLUB_LEADER, { kind: 'club', clubId: 'club-other' }),
      'IFC-ERR-003',
    );
  });

  it('社团负责人/人事：仅部门级作用域却导出全社团 → 作用域不匹配（IFC-ERR-004）', () => {
    expectErrorCode(
      () => authorizeBatchExportScope(CLUB_LEADER_DEPT_ONLY, { kind: 'club', clubId: 'club-1' }),
      'IFC-ERR-004',
    );
  });

  it('社团负责人/人事：本社团内部门子集导出收敛为 department', () => {
    const r = authorizeBatchExportScope(CLUB_LEADER, {
      kind: 'department',
      clubId: 'club-1',
      departmentId: 'dept-A',
    });
    assert.equal(r.kind, 'department');
    assert.deepEqual(r.departmentIds, ['dept-A']);
    assert.equal(r.privileged, false);
  });

  it('社团负责人/人事：本社团全范围导出收敛为 club', () => {
    const r = authorizeBatchExportScope(CLUB_LEADER, { kind: 'club', clubId: 'club-1' });
    assert.equal(r.kind, 'club');
    assert.equal(r.clubId, 'club-1');
    assert.equal(r.privileged, false);
  });

  it('平台超管：platform 级导出收敛为 privileged=true', () => {
    const admin = platformSuperAdminPrincipal('admin-1');
    const r = authorizeBatchExportScope(admin, { kind: 'platform' });
    assert.equal(r.kind, 'platform');
    assert.equal(r.privileged, true);
    assert.equal(r.clubId, null);
  });

  it('平台超管：指定社团导出缺 clubId → 校验错误（IFC-ERR-005）', () => {
    const admin = platformSuperAdminPrincipal('admin-1');
    expectErrorCode(() => authorizeBatchExportScope(admin, { kind: 'club' }), 'IFC-ERR-005');
  });

  it('平台超管：指定社团/部门导出收敛为 privileged=true', () => {
    const admin = platformSuperAdminPrincipal('admin-1');
    const club = authorizeBatchExportScope(admin, { kind: 'club', clubId: 'club-1' });
    assert.equal(club.privileged, true);
    assert.equal(club.clubId, 'club-1');
    const dept = authorizeBatchExportScope(admin, {
      kind: 'department',
      clubId: 'club-1',
      departmentId: 'dept-A',
    });
    assert.deepEqual(dept.departmentIds, ['dept-A']);
    assert.equal(dept.privileged, true);
  });
});

describe('convergeJointExportScope 联合导出收敛（JNT-023）', () => {
  const participants = ['club-1', 'club-2'];

  it('平台超管：收敛为 joint 且 privileged=true，不限定单一社团', () => {
    const admin = platformSuperAdminPrincipal('admin-1');
    const r = convergeJointExportScope(admin, participants, undefined);
    assert.equal(r.kind, 'joint');
    assert.deepEqual(r.participantClubIds, participants);
    assert.equal(r.privileged, true);
  });

  it('非参与社团负责人 → 拒绝（IFC-ERR-003）', () => {
    const outsider = clubLeaderPrincipal('hr-9', 'club-9');
    expectErrorCode(
      () => convergeJointExportScope(outsider, participants, undefined),
      'IFC-ERR-003',
    );
  });

  it('部门负责人/面试官/成员 → 拒绝（IFC-ERR-003）', () => {
    expectErrorCode(
      () => convergeJointExportScope(DEPT_LEADER, participants, undefined),
      'IFC-ERR-003',
    );
    expectErrorCode(
      () => convergeJointExportScope(INTERVIEWER, participants, undefined),
      'IFC-ERR-003',
    );
    expectErrorCode(() => convergeJointExportScope(MEMBER, participants, undefined), 'IFC-ERR-003');
  });

  it('显式指定社团与授权社团不一致 → 作用域不匹配（IFC-ERR-004）', () => {
    const leader = clubLeaderPrincipal('hr-1', 'club-1');
    expectErrorCode(() => convergeJointExportScope(leader, participants, 'club-2'), 'IFC-ERR-004');
  });

  it('参与社团负责人 → 收敛为 joint（privileged=false）', () => {
    const leader = clubLeaderPrincipal('hr-1', 'club-1');
    const r = convergeJointExportScope(leader, participants, 'club-1');
    assert.equal(r.kind, 'joint');
    assert.equal(r.clubId, 'club-1');
    assert.deepEqual(r.participantClubIds, participants);
    assert.equal(r.privileged, false);
  });
});

describe('authorizePersonalCopy 个人副本收敛（EXP-003）', () => {
  it('普通成员：仅本人；代他人 → 拒绝（IFC-ERR-003）', () => {
    assert.deepEqual(authorizePersonalCopy(MEMBER, undefined, {}), {
      targetUserId: 'mem-1',
      clubId: null,
      departmentId: null,
    });
    expectErrorCode(() => authorizePersonalCopy(MEMBER, 'other', {}), 'IFC-ERR-003');
  });

  it('普通面试官：不可导出个人副本（IFC-ERR-003）', () => {
    expectErrorCode(() => authorizePersonalCopy(INTERVIEWER, undefined, {}), 'IFC-ERR-003');
  });

  it('部门负责人：缺 clubId/departmentId → 校验错误（IFC-ERR-005）', () => {
    expectErrorCode(() => authorizePersonalCopy(DEPT_LEADER, 't', {}), 'IFC-ERR-005');
  });

  it('部门负责人：无该社团作用域 → 拒绝（IFC-ERR-003）', () => {
    expectErrorCode(
      () => authorizePersonalCopy(DEPT_LEADER, 't', { clubId: 'club-9', departmentId: 'dept-A' }),
      'IFC-ERR-003',
    );
  });

  it('部门负责人：部门不在可导出集合 → 作用域不匹配（IFC-ERR-004）', () => {
    expectErrorCode(
      () => authorizePersonalCopy(DEPT_LEADER, 't', { clubId: 'club-1', departmentId: 'dept-X' }),
      'IFC-ERR-004',
    );
  });

  it('部门负责人：合法代申请个人副本收敛到部门归属', () => {
    assert.deepEqual(
      authorizePersonalCopy(DEPT_LEADER, 't', { clubId: 'club-1', departmentId: 'dept-A' }),
      { targetUserId: 't', clubId: 'club-1', departmentId: 'dept-A' },
    );
  });

  it('社团负责人/人事：缺 clubId → 校验错误（IFC-ERR-005）', () => {
    expectErrorCode(() => authorizePersonalCopy(CLUB_LEADER, 't', {}), 'IFC-ERR-005');
  });

  it('社团负责人/人事：仅部门级作用域却代社团副本 → 拒绝（IFC-ERR-003）', () => {
    expectErrorCode(
      () => authorizePersonalCopy(CLUB_LEADER_DEPT_ONLY, 't', { clubId: 'club-1' }),
      'IFC-ERR-003',
    );
  });

  it('社团负责人/人事：合法代申请个人副本收敛到社团归属', () => {
    assert.deepEqual(authorizePersonalCopy(CLUB_LEADER, 't', { clubId: 'club-1' }), {
      targetUserId: 't',
      clubId: 'club-1',
      departmentId: null,
    });
  });

  it('平台超管：任意个人副本（privileged 语义由调用方标记）', () => {
    const admin = platformSuperAdminPrincipal('admin-1');
    assert.deepEqual(
      authorizePersonalCopy(admin, 'anyone', { clubId: 'club-1', departmentId: 'dept-A' }),
      {
        targetUserId: 'anyone',
        clubId: 'club-1',
        departmentId: 'dept-A',
      },
    );
  });
});

describe('authorizeContactOptIn 联系方式勾选闸门（5.4.3，EXP-002/EXP-003）', () => {
  it('未勾选（includeContact 缺省/false）→ 任何身份一律放行（默认不导出即无需授权）', () => {
    for (const principal of [CLUB_LEADER, DEPT_LEADER, INTERVIEWER, MEMBER]) {
      assert.doesNotThrow(() =>
        authorizeContactOptIn(principal, { kind: 'club', includeContact: false }),
      );
      assert.doesNotThrow(() => authorizeContactOptIn(principal, { kind: 'personal' }));
    }
    const admin = platformSuperAdminPrincipal('admin-1');
    assert.doesNotThrow(() => authorizeContactOptIn(admin, { kind: 'platform' }));
  });

  it('社团负责人/人事勾选 → 允许（批量与个人副本均可）', () => {
    assert.doesNotThrow(() =>
      authorizeContactOptIn(CLUB_LEADER, { kind: 'club', includeContact: true }),
    );
    assert.doesNotThrow(() =>
      authorizeContactOptIn(CLUB_LEADER, {
        kind: 'personal',
        targetUserId: 'someone-else',
        includeContact: true,
      }),
    );
  });

  it('部门负责人勾选 → 允许', () => {
    assert.doesNotThrow(() =>
      authorizeContactOptIn(DEPT_LEADER, {
        kind: 'department',
        clubId: 'club-1',
        departmentId: 'dept-A',
        includeContact: true,
      }),
    );
  });

  it('平台超管勾选 → 允许（特权身份字段级可见）', () => {
    const admin = platformSuperAdminPrincipal('admin-1');
    assert.doesNotThrow(() =>
      authorizeContactOptIn(admin, { kind: 'platform', includeContact: true }),
    );
  });

  it('普通面试官：任何形式勾选 → 一律拒绝（IFC-ERR-003，含本人个人副本）', () => {
    expectErrorCode(
      () => authorizeContactOptIn(INTERVIEWER, { kind: 'club', includeContact: true }),
      'IFC-ERR-003',
    );
    expectErrorCode(
      () =>
        authorizeContactOptIn(INTERVIEWER, {
          kind: 'personal',
          targetUserId: INTERVIEWER.userId,
          includeContact: true,
        }),
      'IFC-ERR-003',
    );
  });

  it('普通成员/申请人：本人个人副本勾选 → 允许（target 缺省视为本人）', () => {
    assert.doesNotThrow(() =>
      authorizeContactOptIn(MEMBER, { kind: 'personal', includeContact: true }),
    );
    assert.doesNotThrow(() =>
      authorizeContactOptIn(MEMBER, {
        kind: 'personal',
        targetUserId: MEMBER.userId,
        includeContact: true,
      }),
    );
  });

  it('普通成员/申请人：代他人个人副本 / 对批量作用域勾选 → 拒绝（IFC-ERR-003）', () => {
    expectErrorCode(
      () =>
        authorizeContactOptIn(MEMBER, {
          kind: 'personal',
          targetUserId: 'other-user',
          includeContact: true,
        }),
      'IFC-ERR-003',
    );
    expectErrorCode(
      () => authorizeContactOptIn(MEMBER, { kind: 'club', clubId: 'club-1', includeContact: true }),
      'IFC-ERR-003',
    );
    expectErrorCode(
      () =>
        authorizeContactOptIn(MEMBER, {
          kind: 'joint',
          jointActivityId: 'J1',
          includeContact: true,
        }),
      'IFC-ERR-003',
    );
  });
});

describe('revalidateExportScope 静态作用域重验', () => {
  const personalSnap: ExportScopeRevalidateInput = {
    scope: {
      kind: 'personal',
      clubId: null,
      departmentId: null,
      jointActivityId: null,
      participantClubIds: [],
    },
    personalTargetUserId: null,
  };
  const jointSnap: ExportScopeRevalidateInput = {
    scope: {
      kind: 'joint',
      clubId: 'club-1',
      departmentId: null,
      jointActivityId: 'joint-1',
      participantClubIds: ['club-1', 'club-2'],
    },
    personalTargetUserId: null,
  };
  const clubSnap: ExportScopeRevalidateInput = {
    scope: {
      kind: 'club',
      clubId: 'club-1',
      departmentId: null,
      jointActivityId: null,
      participantClubIds: [],
    },
    personalTargetUserId: null,
  };
  const deptSnap: ExportScopeRevalidateInput = {
    scope: {
      kind: 'department',
      clubId: 'club-1',
      departmentId: 'dept-A',
      jointActivityId: null,
      participantClubIds: [],
    },
    personalTargetUserId: null,
  };
  const platformSnap: ExportScopeRevalidateInput = {
    scope: {
      kind: 'platform',
      clubId: null,
      departmentId: null,
      jointActivityId: null,
      participantClubIds: [],
    },
    personalTargetUserId: null,
  };

  it('member 重验 personal 通过，重验批量被拒', () => {
    assert.doesNotThrow(() => revalidateExportScope(MEMBER, personalSnap));
    expectErrorCode(() => revalidateExportScope(MEMBER, clubSnap), 'IFC-ERR-003');
  });

  it('interviewer 重验 personal 被拒', () => {
    expectErrorCode(() => revalidateExportScope(INTERVIEWER, personalSnap), 'IFC-ERR-003');
  });

  it('参与社团负责人重验 joint 通过；部门负责人被拒', () => {
    const leader = clubLeaderPrincipal('hr-1', 'club-1');
    assert.doesNotThrow(() => revalidateExportScope(leader, jointSnap));
    expectErrorCode(() => revalidateExportScope(DEPT_LEADER, jointSnap), 'IFC-ERR-003');
  });

  it('部门负责人重验 club 作用域被拒（IFC-ERR-004）', () => {
    expectErrorCode(() => revalidateExportScope(DEPT_LEADER, clubSnap), 'IFC-ERR-004');
  });

  it('部门负责人重验 department 走 default 分支：合法部门通过、缺 departmentId 拒绝（IFC-ERR-005）', () => {
    // platform / department 走 default → authorizeBatchExportScope
    assert.doesNotThrow(() => revalidateExportScope(DEPT_LEADER, deptSnap));
    expectErrorCode(
      () =>
        revalidateExportScope(DEPT_LEADER, {
          ...deptSnap,
          scope: { ...deptSnap.scope, departmentId: null },
        }),
      'IFC-ERR-005',
    );
  });

  it('平台超管重验 platform 走 default 分支 → 特权通过', () => {
    const admin = platformSuperAdminPrincipal('admin-1');
    assert.doesNotThrow(() => revalidateExportScope(admin, platformSnap));
  });
});

describe('assertPersonalCopyTargetInScope / revalidateExportScopeWithFacts 归属回源', () => {
  function makeFacts(seed: (f: InMemoryExportFactSource) => void): InMemoryExportFactSource {
    const f = new InMemoryExportFactSource();
    seed(f);
    return f;
  }

  it('本人导出无需回源，直接通过', async () => {
    const f = makeFacts(() => {});
    await assertPersonalCopyTargetInScope(
      DEPT_LEADER,
      'dept-1',
      { clubId: 'club-1', departmentId: 'dept-A' },
      f,
    );
  });

  it('部门负责人：target 在本部门成员 → 通过', async () => {
    const f = makeFacts((x) => x.seedDepartmentMembers('club-1', 'dept-A', ['t-1']));
    await assertPersonalCopyTargetInScope(
      DEPT_LEADER,
      't-1',
      { clubId: 'club-1', departmentId: 'dept-A' },
      f,
    );
  });

  it('部门负责人：target 在本部门招新路径申请人 → 通过', async () => {
    const f = makeFacts((x) => x.seedDepartmentApplicants('club-1', 'dept-A', ['t-2']));
    await assertPersonalCopyTargetInScope(
      DEPT_LEADER,
      't-2',
      { clubId: 'club-1', departmentId: 'dept-A' },
      f,
    );
  });

  it('部门负责人：target 既非成员也非申请人 → 拒绝（IFC-ERR-003）', async () => {
    const f = makeFacts((x) => x.seedDepartmentMembers('club-1', 'dept-A', ['t-1']));
    await expectErrorCodeAsync(
      () =>
        assertPersonalCopyTargetInScope(
          DEPT_LEADER,
          'stranger',
          { clubId: 'club-1', departmentId: 'dept-A' },
          f,
        ),
      'IFC-ERR-003',
    );
  });

  it('社团负责人/人事：target 在本社团成员 → 通过；否则拒绝', async () => {
    const fOk = makeFacts((x) => x.seedClubMembers('club-1', ['t-1']));
    await assertPersonalCopyTargetInScope(
      CLUB_LEADER,
      't-1',
      { clubId: 'club-1', departmentId: null },
      fOk,
    );
    const fNo = makeFacts(() => {});
    await expectErrorCodeAsync(
      () =>
        assertPersonalCopyTargetInScope(
          CLUB_LEADER,
          'stranger',
          { clubId: 'club-1', departmentId: null },
          fNo,
        ),
      'IFC-ERR-003',
    );
  });

  it('revalidateExportScopeWithFacts：member 本人 personal 通过', async () => {
    const snap: ExportScopeRevalidateInput = {
      scope: {
        kind: 'personal',
        clubId: null,
        departmentId: null,
        jointActivityId: null,
        participantClubIds: [],
      },
      personalTargetUserId: null,
    };
    const f = makeFacts(() => {});
    await revalidateExportScopeWithFacts(MEMBER, snap, f);
  });

  it('revalidateExportScopeWithFacts：部门负责人代申请 target 离部 → 拒绝', async () => {
    const snap: ExportScopeRevalidateInput = {
      scope: {
        kind: 'personal',
        clubId: 'club-1',
        departmentId: 'dept-A',
        jointActivityId: null,
        participantClubIds: [],
      },
      personalTargetUserId: 'left',
    };
    const f = makeFacts((x) => x.seedDepartmentMembers('club-1', 'dept-A', ['t-1']));
    await expectErrorCodeAsync(
      () => revalidateExportScopeWithFacts(DEPT_LEADER, snap, f),
      'IFC-ERR-003',
    );
  });
});

describe('assertNotSuspended 停用封锁（JNT-023）', () => {
  function makeFacts(seed: (f: InMemoryExportFactSource) => void): InMemoryExportFactSource {
    const f = new InMemoryExportFactSource();
    seed(f);
    return f;
  }
  const base = {
    scope: { clubId: null, departmentId: null, jointActivityId: null, participantClubIds: [] },
    personalTargetUserId: null,
  };

  it('club 未停用 → 通过；社团强制停用 → 拒绝（IFC-ERR-006）', async () => {
    const fOk = makeFacts((x) => x.seedClubContext({ clubId: 'club-1', forcedSuspension: false }));
    await assertNotSuspended(
      { scope: { ...base.scope, kind: 'club', clubId: 'club-1' }, personalTargetUserId: null },
      fOk,
    );

    const fSusp = makeFacts((x) => x.seedClubContext({ clubId: 'club-1', forcedSuspension: true }));
    await expectErrorCodeAsync(
      () =>
        assertNotSuspended(
          { scope: { ...base.scope, kind: 'club', clubId: 'club-1' }, personalTargetUserId: null },
          fSusp,
        ),
      'IFC-ERR-006',
    );
  });

  it('社团不存在 → 拒绝（IFC-ERR-015）', async () => {
    const f = makeFacts(() => {});
    await expectErrorCodeAsync(
      () =>
        assertNotSuspended(
          {
            scope: { ...base.scope, kind: 'department', clubId: 'ghost', departmentId: 'dept-A' },
            personalTargetUserId: null,
          },
          f,
        ),
      'IFC-ERR-015',
    );
  });

  it('personal 无社团边界（clubId=null）→ 不拦截', async () => {
    const f = makeFacts(() => {});
    await assertNotSuspended({ ...base, scope: { ...base.scope, kind: 'personal' } }, f);
  });

  it('platform 平台级导出 → 不涉及停用拦截（超管平台导出直达）', async () => {
    // 平台超管平台级导出（kind=platform，clubId=null）不涉社团停用封锁
    const f = makeFacts(() => {});
    await assertNotSuspended({ ...base, scope: { ...base.scope, kind: 'platform' } }, f);
  });

  it('joint：任一参与社团紧急停用 → 拒绝；全部未停用 → 通过', async () => {
    const fOk = makeFacts((x) => x.seedParticipantClubs('joint-1', ['club-1', 'club-2']));
    await assertNotSuspended(
      {
        scope: {
          ...base.scope,
          kind: 'joint',
          jointActivityId: 'joint-1',
          participantClubIds: ['club-1', 'club-2'],
        },
        personalTargetUserId: null,
      },
      fOk,
    );

    const fSusp = makeFacts((x) => {
      x.seedParticipantClubs('joint-1', ['club-1', 'club-2']);
      x.seedSuspendedClub('joint-1', ['club-2']);
    });
    await expectErrorCodeAsync(
      () =>
        assertNotSuspended(
          {
            scope: {
              ...base.scope,
              kind: 'joint',
              jointActivityId: 'joint-1',
              participantClubIds: ['club-1', 'club-2'],
            },
            personalTargetUserId: null,
          },
          fSusp,
        ),
      'IFC-ERR-006',
    );
  });

  it('joint：快照无参与方时按事实回源拉取参与方', async () => {
    const f = makeFacts((x) => x.seedParticipantClubs('joint-1', ['club-1']));
    await assertNotSuspended(
      {
        scope: { ...base.scope, kind: 'joint', jointActivityId: 'joint-1', participantClubIds: [] },
        personalTargetUserId: null,
      },
      f,
    );
  });
});

describe('assertFreshReauth 重认证新鲜度（IFC-ERR-002）', () => {
  const now = new Date('2026-08-24T00:00:00Z');

  it('从未重认证 → 拒绝（IFC-ERR-002）', async () => {
    const reauth = new MemoryExportReauthPort();
    await expectErrorCodeAsync(
      () => assertFreshReauth(reauth, 'admin-1', undefined, now),
      'IFC-ERR-002',
    );
  });

  it('新鲜重认证通过', async () => {
    const reauth = new MemoryExportReauthPort();
    reauth.recordReauth('admin-1', new Date(now.getTime() - 60_000));
    await assertFreshReauth(reauth, 'admin-1', undefined, now);
  });

  it('重认证已过期 → 拒绝（IFC-ERR-002）', async () => {
    const reauth = new MemoryExportReauthPort();
    reauth.recordReauth('admin-1', new Date(now.getTime() - SUPER_ADMIN_REAUTH_TTL_MS - 1));
    await expectErrorCodeAsync(
      () => assertFreshReauth(reauth, 'admin-1', undefined, now),
      'IFC-ERR-002',
    );
  });

  it('客户端声明时间戳晚于服务端重认证时间（伪造）→ 拒绝', async () => {
    const reauth = new MemoryExportReauthPort();
    reauth.recordReauth('admin-1', new Date(now.getTime() - 60_000));
    // 客户端声称在未来（晚于服务端最新时间）→ 视为伪造
    await expectErrorCodeAsync(
      () => assertFreshReauth(reauth, 'admin-1', new Date(now.getTime() + 1000).toISOString(), now),
      'IFC-ERR-002',
    );
  });

  it('客户端声明时间戳无效（NaN）→ 拒绝，不静默绕过', async () => {
    const reauth = new MemoryExportReauthPort();
    reauth.recordReauth('admin-1', new Date(now.getTime() - 60_000));
    await expectErrorCodeAsync(
      () => assertFreshReauth(reauth, 'admin-1', 'not-a-timestamp', now),
      'IFC-ERR-002',
    );
  });
});

describe('便捷主体工厂', () => {
  it('platformSuperAdminPrincipal 构造超管主体', () => {
    const p = platformSuperAdminPrincipal('admin-1');
    assert.equal(p.kind, 'platform_super_admin');
    assert.deepEqual(p.clubScopes, []);
  });

  it('clubLeaderPrincipal 构造社团负责人主体（含额外作用域）', () => {
    const p = clubLeaderPrincipal('hr-1', 'club-1', [
      { clubId: 'club-2', level: 'department', departmentIds: ['dept-X'] },
    ]);
    assert.equal(p.kind, 'club_leader_hr');
    assert.equal(p.clubScopes[0].level, 'club');
    assert.equal(p.clubScopes[1].level, 'department');
    assert.deepEqual(p.clubScopes[1].departmentIds, ['dept-X']);
  });

  it('未知导出者分类：类型穷尽保护兜底拒绝（IFC-ERR-003）', () => {
    const unknown = { userId: 'u', kind: 'legacy', clubScopes: [] } as unknown as ExportPrincipal;
    expectErrorCode(() => authorizeBatchExportScope(unknown, { kind: 'platform' }), 'IFC-ERR-003');
  });
});
