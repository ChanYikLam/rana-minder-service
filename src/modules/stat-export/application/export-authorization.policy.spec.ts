/**
 * 导出权限收敛策略逐分支测试（P1 任务⑤；EXP-002/003）。
 *
 * 覆盖：社团负责人本社团允许/跨社拒绝、普通成员禁止批量导出、
 * 超管特权标记、重认证窗口常量、isExportError 判别。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  authorizeBatchExportScope,
  isExportError,
  SUPER_ADMIN_REAUTH_TTL_MS,
} from './export-authorization.policy';
import type { ExportPrincipal } from './ports/export-authorization.port';

function clubLeader(clubId: string): ExportPrincipal {
  return {
    userId: 'u_leader',
    kind: 'club_leader_hr',
    clubScopes: [{ clubId, level: 'club' as const, departmentIds: [] }],
  };
}

function plainMember(): ExportPrincipal {
  return { userId: 'u_member', kind: 'member_applicant', clubScopes: [] };
}

function superAdmin(): ExportPrincipal {
  return { userId: 'u_root', kind: 'platform_super_admin', clubScopes: [] };
}

describe('authorizeBatchExportScope（5 类导出者作用域收敛）', () => {
  it('社团负责人：请求本社团 → 允许 + 非特权', () => {
    const r = authorizeBatchExportScope(clubLeader('club-a'), {
      kind: 'club',
      clubId: 'club-a',
    });
    assert.equal(r.kind, 'club');
    assert.equal(r.privileged, false);
  });

  it('社团负责人：请求其他社团 → 拒绝（越权）', () => {
    assert.throws(
      () =>
        authorizeBatchExportScope(clubLeader('club-a'), {
          kind: 'club',
          clubId: 'club-b',
        }),
      (e: unknown) => {
        const msg = (e as Error).message;
        return msg.includes('IFC-ERR') || msg.includes('越权') || msg.includes('无权');
      },
    );
  });

  it('普通成员：任何批量导出一律拒绝', () => {
    assert.throws(
      () =>
        authorizeBatchExportScope(plainMember(), {
          kind: 'club',
          clubId: 'club-a',
        }),
      (e: unknown) => {
        const msg = (e as Error).message;
        return msg.includes('IFC-ERR') || msg.includes('禁止') || msg.includes('无权');
      },
    );
  });

  it('平台超管：请求全平台 → 允许 + privileged=true', () => {
    const r = authorizeBatchExportScope(superAdmin(), { kind: 'platform' });
    assert.equal(r.kind, 'platform');
    assert.equal(r.privileged, true);
  });
});

describe('SUPER_ADMIN_REAUTH_TTL_MS / isExportError', () => {
  it('超管重认证窗口 = 10 分钟', () => {
    assert.equal(SUPER_ADMIN_REAUTH_TTL_MS, 600_000);
  });

  it('isExportError：ExportError instanceof → true；普通 Error → false', () => {
    assert.equal(isExportError(new Error('plain')), false);
    // 构造真实 ExportError（通过 exportErrors 工厂）
    try {
      authorizeBatchExportScope(plainMember(), { kind: 'club', clubId: 'x' });
    } catch (e) {
      if (isExportError(e)) {
        assert.ok(true, '捕获的越权错误是 ExportError 实例');
        return;
      }
      assert.fail('越权错误应为 ExportError');
    }
    assert.fail('应抛出错误');
  });
});
