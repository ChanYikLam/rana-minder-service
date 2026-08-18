import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  DefaultAuditBoundaryAssert,
  AuditBoundaryViolation,
} from './audit-boundary';

describe('audit-boundary (DefaultAuditBoundaryAssert / XCC-GEN-007)', () => {
  const assert1 = new DefaultAuditBoundaryAssert();

  it('audit.* 前缀拒绝', () => {
    assert.throws(() => assert1.assert('audit.raw'), AuditBoundaryViolation);
    assert.throws(() => assert1.assert('audit.id'), AuditBoundaryViolation);
  });

  it('permission.* / role.* / authorization.* / decision.* 拒绝', () => {
    assert.throws(() => assert1.assert('permission.user1'), AuditBoundaryViolation);
    assert.throws(() => assert1.assert('role.admin'), AuditBoundaryViolation);
    assert.throws(() => assert1.assert('authorization.token'), AuditBoundaryViolation);
    assert.throws(() => assert1.assert('decision.result'), AuditBoundaryViolation);
  });

  it('大小写不敏感', () => {
    assert.throws(() => assert1.assert('AUDIT.raw'), AuditBoundaryViolation);
    assert.throws(() => assert1.assert('Role.Admin'), AuditBoundaryViolation);
  });

  it('运行日志常用字段通过', () => {
    assert1.assert('userId');
    assert1.assert('status');
    assert1.assert('phone');
    assert1.assert('email');
    assert1.assert('requestId');
  });

  it('isForbidden 不抛错，仅返回布尔', () => {
    assert.equal(assert1.isForbidden('audit.id'), true);
    assert.equal(assert1.isForbidden('userId'), false);
  });

  it('extraForbiddenPrefixes 追加前缀', () => {
    const stricter = new DefaultAuditBoundaryAssert({
      extraForbiddenPrefixes: [/^custom\./i],
    });
    assert.throws(() => stricter.assert('custom.field'), AuditBoundaryViolation);
    assert1.assert('custom.field');
  });
});