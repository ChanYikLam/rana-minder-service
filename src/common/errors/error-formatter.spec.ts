/**
 * 错误格式化单测（P2 零覆盖补测：src/common/errors，错误码头禁）。
 *
 * 契约：format 只输出 code/message(+field)，不携带内部细节/堆栈/额外键
 * （接口契约 §8 脱敏要求；API-ERR-001）。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { ErrorFormatter } from './error-formatter';
import { ErrorCode } from './error-code';

describe('ErrorFormatter（错误码头禁）', () => {
  const formatter = new ErrorFormatter();

  it('输出 code + message，不带 field', () => {
    const detail = formatter.format({ code: ErrorCode.FORBIDDEN, message: '无权限' });
    assert.deepEqual(detail, { code: ErrorCode.FORBIDDEN, message: '无权限' });
    assert.equal(Object.keys(detail).length, 2);
  });

  it('带 field 时仅追加 field 键', () => {
    const detail = formatter.format({
      code: ErrorCode.VALIDATION_FAILED,
      message: '字段不合法',
      field: 'email',
    });
    assert.deepEqual(detail, {
      code: ErrorCode.VALIDATION_FAILED,
      message: '字段不合法',
      field: 'email',
    });
    assert.equal(Object.keys(detail).length, 3);
  });

  it('不泄漏内部细节键（stack/detail/inner 等一律剥除）', () => {
    const detail = formatter.format({
      code: ErrorCode.INTERNAL,
      message: '服务器内部错误',
    }) as unknown as Record<string, unknown>;
    for (const forbidden of ['stack', 'detail', 'cause', 'inner', 'sql']) {
      assert.equal(forbidden in detail, false);
    }
  });

  it('错误码目录：IFC-ERR 编号齐全且唯一', () => {
    const values = Object.values(ErrorCode);
    assert.ok(values.length >= 15, `当前 ${values.length} 个错误码（含 IFC-ERR-002~016 主体）`);
    assert.equal(new Set(values).size, values.length);
    // 高风险重认证与作用域越界是安全关键码，必须存在且编号正确
    assert.equal(ErrorCode.REAUTH_REQUIRED, 'IFC-ERR-002');
    assert.equal(ErrorCode.SCOPE_MISMATCH, 'IFC-ERR-004');
    assert.equal(ErrorCode.NOT_VISIBLE, 'IFC-ERR-015');
  });
});
