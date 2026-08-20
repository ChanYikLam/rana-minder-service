/**
 * 错误 → HTTP 映射单元测试（API-ERR-001 全表抽样 + API-GEN-005 脱敏）。
 *
 * 覆盖：IdentityCommandError 按 code 映射 HTTP 状态与响应体；
 * 未知错误兜底 500 IFC-ERR-016 不泄露细节；verify-email 例外映射。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { toApiError, toVerifyEmailError } from './error-http';
import { IdentityCommandError, IdentityErrorCode } from '../../application/errors';
import { IFC_ERROR_HTTP_STATUS } from '../../../../common/contracts/api-error';

describe('toApiError（API-ERR-001）', () => {
  it('IFC-ERR-001 → 401；响应体仅 code/message/supportId', () => {
    const error = new IdentityCommandError(IdentityErrorCode.UNAUTHENTICATED, '未认证');
    const result = toApiError(error);
    assert.equal(result.status, 401);
    assert.equal(result.status, IFC_ERROR_HTTP_STATUS['IFC-ERR-001']);
    assert.equal(result.body.code, 'IFC-ERR-001');
    assert.equal(result.body.message, '未认证');
    assert.ok(typeof result.body.supportId === 'string' && result.body.supportId.length > 0);
    assert.equal(result.body.fieldErrors, undefined);
  });

  it('IFC-ERR-003 → 403；IFC-ERR-015 → 404；IFC-ERR-012 → 503', () => {
    assert.equal(
      toApiError(new IdentityCommandError(IdentityErrorCode.FORBIDDEN, '无权限')).status,
      403,
    );
    assert.equal(
      toApiError(new IdentityCommandError(IdentityErrorCode.NOT_FOUND, '资料')).status,
      404,
    );
    assert.equal(
      toApiError(new IdentityCommandError(IdentityErrorCode.DEPENDENCY_UNAVAILABLE, '依赖不可用')).status,
      503,
    );
  });

  it('IFC-ERR-005 携带 fieldErrors（结构校验）', () => {
    const error = new IdentityCommandError(IdentityErrorCode.VALIDATION_FAILED, '校验失败', {
      fieldErrors: { phone: ['非法'] },
    });
    const result = toApiError(error);
    assert.equal(result.status, 422);
    assert.deepEqual(result.body.fieldErrors, { phone: ['非法'] });
  });

  it('API-GEN-005：未知错误 → 500 IFC-ERR-016，不泄露内部细节', () => {
    const result = toApiError(new Error('stack trace and secrets'));
    assert.equal(result.status, 500);
    assert.equal(result.body.code, 'IFC-ERR-016');
    assert.equal(result.body.message.includes('stack'), false);
  });

  it('API-GEN-005：支持键白名单——错误响应只含四类信息', () => {
    const result = toApiError(new IdentityCommandError(IdentityErrorCode.VALIDATION_FAILED, 'x'));
    assert.deepEqual(Object.keys(result.body).sort(), ['code', 'message', 'supportId']);
  });
});

describe('toVerifyEmailError（接口清单 §4 例外）', () => {
  it('验证码错误/过期（PRECONDITION_FAILED）→ 422 IFC-ERR-007 + fieldErrors.code', () => {
    const error = new IdentityCommandError(IdentityErrorCode.PRECONDITION_FAILED, '验证码不正确');
    const result = toVerifyEmailError(error);
    assert.equal(result.status, 422);
    assert.equal(result.body.code, 'IFC-ERR-007');
    assert.deepEqual(result.body.fieldErrors, { code: ['验证码不正确'] });
  });

  it('非验证码错误透传默认映射', () => {
    const error = new IdentityCommandError(IdentityErrorCode.NOT_FOUND, '验证请求');
    const result = toVerifyEmailError(error);
    assert.equal(result.status, 404);
    assert.equal(result.body.code, 'IFC-ERR-015');
  });
});