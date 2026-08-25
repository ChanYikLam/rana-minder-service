/**
 * 安全控制独立验证：SEC-CTL-015 / SEC-CTL-016。
 *
 * 权威来源：docs/specification/安全设计与实现级威胁模型-v1.0.md §5/§10；
 * 接口契约-v1.0 §8（IFC-ERR-001~016）、接口实现规格-v1.0 §7（API-ERR-001）。
 *
 * 验证路径（真实代码，无 pg/jose 依赖）：
 * - src/common/contracts/api-error.ts（17 类 IFC 码目录 + HTTP 映射）
 * - src/common/errors/error-formatter.ts（脱敏错误对象）
 * - src/modules/identity/interfaces/http/error-http.ts（toApiError 兜底与体键集）
 * - src/modules/identity/application/errors.ts（存在性隐藏文案）
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { IFC_ERROR_CODES, IFC_ERROR_HTTP_STATUS } from '../../src/common/contracts/api-error';
import { ErrorFormatter } from '../../src/common/errors/error-formatter';
import { ErrorCode } from '../../src/common/errors/error-code';
import { toApiError } from '../../src/modules/identity/interfaces/http/error-http';
import {
  IdentityCommandError,
  IdentityErrorCode,
  identityErrors,
} from '../../src/modules/identity/application/errors';
import {
  generateTraceId,
  isTraceId,
} from '../../src/platform/observability/domain/services/trace-id.generator';
import { assertIdempotencyKeyDistinctFromTrackingNumber } from '../../src/platform/tasks/idempotency/idempotency-key';

describe('SEC-CTL-016 错误传输中立分类与披露允许清单', () => {
  it('SEC-CTL-016：错误码目录恰为 17 类 IFC 码、唯一且编号连续', () => {
    assert.equal(IFC_ERROR_CODES.length, 17);
    assert.equal(new Set(IFC_ERROR_CODES).size, 17);
    IFC_ERROR_CODES.forEach((code, index) => {
      assert.match(code, /^IFC-ERR-\d{3}$/);
      assert.equal(code, `IFC-ERR-${String(index + 1).padStart(3, '0')}`);
    });
  });

  it('SEC-CTL-016：17 类错误码全部具备 HTTP 状态映射且落在合法区间', () => {
    for (const code of IFC_ERROR_CODES) {
      const status = IFC_ERROR_HTTP_STATUS[code];
      assert.equal(typeof status, 'number');
      assert.ok(status >= 200 && status <= 599, `${code} 映射非法状态 ${status}`);
    }
    assert.equal(IFC_ERROR_HTTP_STATUS['IFC-ERR-001'], 401);
    assert.equal(IFC_ERROR_HTTP_STATUS['IFC-ERR-002'], 401);
    assert.equal(IFC_ERROR_HTTP_STATUS['IFC-ERR-013'], 202);
    assert.equal(IFC_ERROR_HTTP_STATUS['IFC-ERR-016'], 500);
  });

  it('SEC-CTL-016：ErrorFormatter 只输出 code/message[/field]，不携带 stack 或内部细节键', () => {
    const formatter = new ErrorFormatter();
    const withField = formatter.format({
      code: ErrorCode.FORBIDDEN,
      message: '拒绝',
      field: 'name',
    });
    assert.deepEqual(Object.keys(withField).sort(), ['code', 'field', 'message']);
    const withoutField = formatter.format({ code: ErrorCode.INTERNAL, message: 'x' });
    assert.deepEqual(Object.keys(withoutField), ['code', 'message']);
    const serialized = JSON.stringify([withField, withoutField]);
    assert.ok(!serialized.includes('stack'));
    assert.ok(!serialized.includes('internalPath'));
  });

  it('SEC-CTL-016：toApiError 体键集恰为 {code,message,supportId[,fieldErrors]}，details 其余键不外泄', () => {
    const plain = toApiError(
      new IdentityCommandError(IdentityErrorCode.REAUTH_REQUIRED, '高风险操作要求重新认证'),
    );
    assert.equal(plain.status, 401);
    assert.deepEqual(Object.keys(plain.body), ['code', 'message', 'supportId']);
    assert.ok(isTraceId(plain.body.supportId));

    const withFields = toApiError(
      new IdentityCommandError(IdentityErrorCode.VALIDATION_FAILED, '输入无效', {
        fieldErrors: { age: ['必须是数字'] },
        internalHint: 'db-row-42',
      }),
    );
    assert.deepEqual(Object.keys(withFields.body), [
      'code',
      'message',
      'supportId',
      'fieldErrors',
    ]);
    assert.equal((withFields.body as unknown as Record<string, unknown>)['internalHint'], undefined);
    assert.deepEqual(withFields.body.fieldErrors, { age: ['必须是数字'] });
  });

  it('SEC-CTL-016：未知错误兜底 500 IFC-ERR-016 固定文案，不透传内部消息、堆栈或内部路径', () => {
    const boom = new Error('ECONNREFUSED 10.0.0.9:5432 at /srv/app/src/db/pool.ts:77');
    const r = toApiError(boom);
    assert.equal(r.status, 500);
    assert.equal(r.body.code, IdentityErrorCode.SECURITY_COMMIT_FAILED);
    assert.equal(r.body.message, '安全提交失败，请稍后重试');
    const serialized = JSON.stringify(r.body);
    assert.ok(!serialized.includes('ECONNREFUSED'), '不得透传原始错误消息');
    assert.ok(!serialized.includes('/srv/app'), '不得泄露内部路径');
    assert.ok(!serialized.includes('stack'), '不得携带堆栈');
    assert.ok(isTraceId(r.body.supportId));
  });

  it('SEC-CTL-016：supportId 为不含个人信息的安全追踪编号，且与业务幂等键严格分离', () => {
    const supportId = toApiError(new Error('x')).body.supportId;
    assert.ok(isTraceId(supportId));
    // 追踪编号不得替代业务幂等键（XCC-GEN-001）：二者混同必须被拒绝
    assert.throws(() =>
      assertIdempotencyKeyDistinctFromTrackingNumber(supportId, supportId),
    );
    assert.doesNotThrow(() =>
      assertIdempotencyKeyDistinctFromTrackingNumber('idem-key-1', supportId),
    );
    assert.notEqual(supportId, generateTraceId());
  });
});

describe('SEC-CTL-015 存在性隐藏与不可见结果', () => {
  it('SEC-CTL-015：无权与不存在共用"不存在或不可见"外部最小文案，映射 404 不泄露存在性', () => {
    const notFound = identityErrors.notFound('报名记录');
    assert.equal(notFound.code, IdentityErrorCode.NOT_FOUND);
    assert.equal(notFound.message, '报名记录不存在或不可见');

    const r = toApiError(notFound);
    assert.equal(r.status, IFC_ERROR_HTTP_STATUS['IFC-ERR-015']);
    assert.equal(r.body.code, 'IFC-ERR-015');
    assert.match(r.body.message, /不存在或不可见/);
    assert.ok(!r.body.message.includes('报名记录-123'), '不得携带具体对象标识以外的内部线索');
  });
});
