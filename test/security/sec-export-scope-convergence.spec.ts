/**
 * 安全控制独立验证：SEC-CTL-005（逐请求重算授权）/ SEC-CTL-014（联合域独立收敛）。
 *
 * 权威来源：docs/specification/安全设计与实现级威胁模型-v1.0.md §5、§7；
 * stat-export EXP-003 / JNT-023 授权边界。
 *
 * 验证路径（真实纯函数策略，无 pg/jose 依赖）：
 * - src/modules/stat-export/application/export-authorization.policy.ts
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  authorizeBatchExportScope,
  convergeJointExportScope,
  isExportError,
  type RequestedExportScope,
} from '../../src/modules/stat-export/application/export-authorization.policy';
import type {
  ExportPrincipal,
} from '../../src/modules/stat-export/application/ports/export-authorization.port';

const clubLeaderOfC1: ExportPrincipal = {
  userId: 'u-leader',
  kind: 'club_leader_hr',
  clubScopes: [{ clubId: 'c1', level: 'club', departmentIds: ['d1'] }],
};

const deptLeaderOfC1D1: ExportPrincipal = {
  userId: 'u-dept',
  kind: 'department_leader',
  clubScopes: [{ clubId: 'c1', level: 'department', departmentIds: ['d1'] }],
};

const superAdmin: ExportPrincipal = {
  userId: 'u-root',
  kind: 'platform_super_admin',
  clubScopes: [],
};

function expectExportError(fn: () => unknown, code: string): void {
  try {
    fn();
    assert.fail(`应当拒绝并抛出 ${code}`);
  } catch (err) {
    assert.ok(isExportError(err), '应抛出 ExportError');
    assert.equal(err.code, code);
  }
}

describe('SEC-CTL-005 每请求按当前身份与作用域重算授权', () => {
  it('SEC-CTL-005：社团负责人本社团批量导出收敛为最小作用域且无特权标记', () => {
    const resolved = authorizeBatchExportScope(clubLeaderOfC1, { kind: 'club', clubId: 'c1' });
    assert.deepEqual(resolved, {
      kind: 'club',
      clubId: 'c1',
      departmentIds: [],
      jointActivityId: null,
      participantClubIds: [],
      privileged: false,
    });
  });

  it('SEC-CTL-005：普通成员/申请人、普通面试官任何批量导出一律拒绝（IFC-ERR-003）', () => {
    const request: RequestedExportScope & { kind: 'club' } = { kind: 'club', clubId: 'c1' };
    expectExportError(
      () =>
        authorizeBatchExportScope(
          { userId: 'u-m', kind: 'member_applicant', clubScopes: [] },
          request,
        ),
      'IFC-ERR-003',
    );
    expectExportError(
      () => authorizeBatchExportScope({ userId: 'u-i', kind: 'interviewer', clubScopes: [] }, request),
      'IFC-ERR-003',
    );
  });

  it('SEC-CTL-005：部门负责人越界请求平台/他社/他部门分别被拒（403 与 404 类区分）', () => {
    expectExportError(
      () => authorizeBatchExportScope(deptLeaderOfC1D1, { kind: 'platform' }),
      'IFC-ERR-003',
    );
    expectExportError(
      () => authorizeBatchExportScope(deptLeaderOfC1D1, { kind: 'club', clubId: 'c9' }),
      'IFC-ERR-004',
    );
    expectExportError(
      () =>
        authorizeBatchExportScope(deptLeaderOfC1D1, {
          kind: 'department',
          clubId: 'c1',
          departmentId: 'dX',
        }),
      'IFC-ERR-004',
    );
  });

  it('SEC-CTL-005：非社团级作用域不得冒充全社团导出；客户端提交的社团不改变授权结果', () => {
    const deptOnlyLeader: ExportPrincipal = {
      userId: 'u-d2',
      kind: 'club_leader_hr',
      clubScopes: [{ clubId: 'c1', level: 'department', departmentIds: ['d1'] }],
    };
    expectExportError(
      () => authorizeBatchExportScope(deptOnlyLeader, { kind: 'platform' }),
      'IFC-ERR-003',
    );
    expectExportError(
      () => authorizeBatchExportScope(deptOnlyLeader, { kind: 'club', clubId: 'c1' }),
      'IFC-ERR-004',
    );
    expectExportError(
      () => authorizeBatchExportScope(clubLeaderOfC1, { kind: 'club', clubId: 'c-other' }),
      'IFC-ERR-003',
    );
  });
});

describe('SEC-CTL-014 联合协作域以锁定参与关系收敛', () => {
  it('SEC-CTL-014：仅参与方清单内具备 club 级作用域者可联合导出，且参与清单来自服务端事实', () => {
    const resolved = convergeJointExportScope(clubLeaderOfC1, ['c1', 'c2'], 'c1');
    assert.equal(resolved.kind, 'joint');
    assert.deepEqual(resolved.participantClubIds, ['c1', 'c2']);
    assert.equal(resolved.privileged, false);
  });

  it('SEC-CTL-014：非参与社团的负责人一律拒绝（JNT-023），部门负责人亦无联合导出权', () => {
    expectExportError(
      () => convergeJointExportScope(clubLeaderOfC1, ['c9'], undefined),
      'IFC-ERR-003',
    );
    expectExportError(() => convergeJointExportScope(deptLeaderOfC1D1, ['c1'], 'c1'), 'IFC-ERR-003');
  });

  it('SEC-CTL-014：平台超管联合导出为特权路径（privileged=true，须特权审计）', () => {
    const resolved = convergeJointExportScope(superAdmin, ['c1', 'c2'], 'j1');
    assert.equal(resolved.kind, 'joint');
    assert.equal(resolved.privileged, true);
    assert.deepEqual(resolved.participantClubIds, ['c1', 'c2']);
  });
});
