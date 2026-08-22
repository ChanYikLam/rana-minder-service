import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  RejectAllStatusPageAuthorizer,
  AlwaysAllowStatusPageAuthorizer,
  IdentityStatusPageAuthorizer,
  StatusPageForbiddenError,
} from './status-page-authorizer';

describe('status-page-authorizer', () => {
  it('RejectAll：未提供 actor 抛 StatusPageForbiddenError', () => {
    const a = new RejectAllStatusPageAuthorizer();
    assert.throws(() => a.assertSuperAdmin(undefined), StatusPageForbiddenError);
  });

  it('RejectAll：任意 actor 也抛（fail-closed）', () => {
    const a = new RejectAllStatusPageAuthorizer();
    assert.throws(
      () => a.assertSuperAdmin({ userId: 'u1', roles: ['super-admin'] }),
      StatusPageForbiddenError,
    );
  });

  it('RejectAll：异步接口同样抛（fail-closed）', async () => {
    const a = new RejectAllStatusPageAuthorizer();
    await assert.rejects(
      a.assertSuperAdminAsync({ userId: 'u1', roles: [] }),
      StatusPageForbiddenError,
    );
  });

  it('AlwaysAllow：不抛（仅本地调试）', () => {
    const a = new AlwaysAllowStatusPageAuthorizer();
    a.assertSuperAdmin(undefined);
    a.assertSuperAdmin({ userId: 'u1', roles: [] });
  });
});

describe('IdentityStatusPageAuthorizer（T5 真实超管判定）', () => {
  it('无 actor / 无 userId：拒绝（fail-closed）', async () => {
    const a = new IdentityStatusPageAuthorizer({ isSuperAdmin: async () => true });
    await assert.rejects(a.assertSuperAdminAsync(undefined), StatusPageForbiddenError);
    await assert.rejects(a.assertSuperAdminAsync({ roles: [] }), StatusPageForbiddenError);
  });

  it('核验器返回 true：放行（当前有效超管）', async () => {
    const a = new IdentityStatusPageAuthorizer({ isSuperAdmin: async () => true });
    await a.assertSuperAdminAsync({ userId: 'u1', roles: [] });
  });

  it('核验器返回 false：拒绝（非超管越权 403）', async () => {
    const a = new IdentityStatusPageAuthorizer({ isSuperAdmin: async () => false });
    await assert.rejects(
      a.assertSuperAdminAsync({ userId: 'u1', roles: ['member'] }),
      StatusPageForbiddenError,
    );
  });

  it('核验器异常：按 fail-closed 拒绝，不放大异常', async () => {
    const a = new IdentityStatusPageAuthorizer({
      isSuperAdmin: async () => {
        throw new Error('verifier down');
      },
    });
    await assert.rejects(
      a.assertSuperAdminAsync({ userId: 'u1', roles: [] }),
      StatusPageForbiddenError,
    );
  });
});
