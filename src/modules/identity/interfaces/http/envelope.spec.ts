/**
 * 信封解析单元测试（API-GEN-003；接口清单 §1.1）。
 *
 * 覆盖：五键白名单、未知键拒绝、非对象体 400、input 类型校验、
 * expectedVersion 整数校验、缺省字段不输出。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseRequestEnvelope } from './envelope';
import { IdentityCommandError, IdentityErrorCode } from '../../application/errors';

describe('parseRequestEnvelope（API-GEN-003）', () => {
  it('NOM：解析完整信封五键', () => {
    const envelope = parseRequestEnvelope({
      action: 'save-profile',
      targetId: 'user-1',
      expectedVersion: 4,
      idempotencyKey: 'k-1',
      input: { phone: '13800000000' },
    });

    assert.equal(envelope.action, 'save-profile');
    assert.equal(envelope.targetId, 'user-1');
    assert.equal(envelope.expectedVersion, 4);
    assert.equal(envelope.idempotencyKey, 'k-1');
    assert.deepEqual(envelope.input, { phone: '13800000000' });
  });

  it('API-GEN-003：省略的键不出现在结果中', () => {
    const envelope = parseRequestEnvelope({ expectedVersion: 3 });
    assert.equal(envelope.expectedVersion, 3);
    assert.equal(envelope.input, undefined);
    assert.equal(envelope.action, undefined);
  });

  it('API-GEN-003：顶层未知键 → 422 IFC-ERR-005 + fieldErrors', () => {
    assert.throws(
      () => parseRequestEnvelope({ email: 'a@example.com' }),
      (error: unknown) => {
        assert.ok(error instanceof IdentityCommandError);
        assert.equal(error.code, IdentityErrorCode.VALIDATION_FAILED);
        assert.ok(error.details?.fieldErrors);
        assert.deepEqual(Object.keys(error.details.fieldErrors as Record<string, unknown>), ['email']);
        return true;
      },
    );
  });

  it('API-GEN-003：非对象请求体 → 400 IFC-ERR-017', () => {
    for (const body of [null, 'text', 42, [1, 2]]) {
      assert.throws(
        () => parseRequestEnvelope(body),
        (error: unknown) =>
          error instanceof IdentityCommandError && error.code === IdentityErrorCode.BAD_REQUEST,
      );
    }
  });

  it('API-GEN-003：input 非对象 → 422 IFC-ERR-005', () => {
    assert.throws(
      () => parseRequestEnvelope({ input: 'flat' }),
      (error: unknown) =>
        error instanceof IdentityCommandError && error.code === IdentityErrorCode.VALIDATION_FAILED,
    );
  });

  it('API-GEN-003：expectedVersion 非整数 → 422 IFC-ERR-005', () => {
    assert.throws(
      () => parseRequestEnvelope({ expectedVersion: '4' }),
      (error: unknown) =>
        error instanceof IdentityCommandError && error.code === IdentityErrorCode.VALIDATION_FAILED,
    );
  });
});