/**
 * form 传输层测试：请求信封解析与错误→HTTP 映射。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseFormRequestEnvelope } from './form-envelope';
import { toApiError } from './form-error-http';
import { FormCommandError, FormErrorCode } from '../../application/errors';

describe('parseFormRequestEnvelope（API-GEN-003）', () => {
  it('合法信封解析五键', () => {
    const envelope = parseFormRequestEnvelope({
      action: 'save',
      targetId: 'f-1',
      expectedVersion: 2,
      idempotencyKey: 'k-1',
      input: { fields: [] },
    });
    assert.equal(envelope.expectedVersion, 2);
    assert.equal(envelope.idempotencyKey, 'k-1');
  });

  it('未知信封字段 → 422 IFC-ERR-005', () => {
    assert.throws(
      () => parseFormRequestEnvelope({ input: {}, rogue: 1 }),
      (error: FormCommandError) => error.code === FormErrorCode.VALIDATION_FAILED,
    );
  });

  it('非对象请求体 → 400 IFC-ERR-017', () => {
    assert.throws(
      () => parseFormRequestEnvelope('plain-text'),
      (error: FormCommandError) => error.code === FormErrorCode.BAD_REQUEST,
    );
  });

  it('expectedVersion 非正整数 → 422 IFC-ERR-005', () => {
    assert.throws(
      () => parseFormRequestEnvelope({ expectedVersion: -1 }),
      (error: FormCommandError) => error.code === FormErrorCode.VALIDATION_FAILED,
    );
    assert.throws(
      () => parseFormRequestEnvelope({ expectedVersion: 1.5 }),
      (error: FormCommandError) => error.code === FormErrorCode.VALIDATION_FAILED,
    );
  });

  it('input 非对象 → 422 IFC-ERR-005', () => {
    assert.throws(
      () => parseFormRequestEnvelope({ input: [] }),
      (error: FormCommandError) => error.code === FormErrorCode.VALIDATION_FAILED,
    );
  });
});

describe('toApiError（API-ERR-001）', () => {
  it('表单设计域状态机拒绝 → 422 IFC-ERR-006', () => {
    const result = toApiError(formError(FormErrorCode.PRECONDITION_FAILED, '仅草稿版本可编辑'));
    assert.equal(result.status, 422);
    assert.equal(result.body.code, 'IFC-ERR-006');
  });

  it('版本冲突 → 409 IFC-ERR-008', () => {
    const result = toApiError(formError(FormErrorCode.VERSION_CONFLICT, '版本冲突'));
    assert.equal(result.status, 409);
    assert.equal(result.body.code, 'IFC-ERR-008');
  });

  it('幂等冲突 → 409 IFC-ERR-009', () => {
    const result = toApiError(formError(FormErrorCode.IDEMPOTENCY_CONFLICT, '幂等冲突'));
    assert.equal(result.status, 409);
    assert.equal(result.body.code, 'IFC-ERR-009');
  });

  it('权限拒绝 → 403 IFC-ERR-003；未找到 → 404 IFC-ERR-015', () => {
    assert.equal(toApiError(formError(FormErrorCode.FORBIDDEN, '无权')).status, 403);
    assert.equal(toApiError(formError(FormErrorCode.NOT_FOUND, '表单')).status, 404);
  });

  it('校验失败携带 fieldErrors，不携带内部细节', () => {
    const result = toApiError(
      new FormCommandError(FormErrorCode.VALIDATION_FAILED, '字段校验失败', {
        fieldErrors: { title: ['标题缺失'] },
      }),
    );
    assert.equal(result.status, 422);
    assert.deepEqual(result.body.fieldErrors, { title: ['标题缺失'] });
    assert.equal('details' in result.body, false);
  });

  it('未知错误 → 500 IFC-ERR-016 兜底（安全提交失败）', () => {
    const result = toApiError(new Error('database exploded'));
    assert.equal(result.status, 500);
    assert.equal(result.body.code, 'IFC-ERR-016');
    assert.equal(result.body.message, '安全提交失败，请稍后重试');
  });
});

function formError(code: FormErrorCode, message: string): FormCommandError {
  return new FormCommandError(code, message);
}
