import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  RejectAllStatusPageAuthorizer,
  AlwaysAllowStatusPageAuthorizer,
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

  it('AlwaysAllow：不抛（仅本地调试）', () => {
    const a = new AlwaysAllowStatusPageAuthorizer();
    a.assertSuperAdmin(undefined);
    a.assertSuperAdmin({ userId: 'u1', roles: [] });
  });
});