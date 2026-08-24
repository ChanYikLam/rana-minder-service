/**
 * 表单字段校验器测试（GOV-003 秘密/注入/骨架；DATA-FRM-003 服务端重验；
 * FORM-004 自动带入只读；FORM-003 角色权限收紧）。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { validateFormFieldSet } from './form-field.validator';
import { FormCommandError, FormErrorCode } from '../../application/errors';
import type { ProfileFieldDirectoryEntry } from '../../application/ports/form-profile-field-directory.port';

const directory: readonly ProfileFieldDirectoryEntry[] = [
  { fieldId: 'email', label: '邮箱', readOnly: false },
  { fieldId: 'name', label: '姓名', readOnly: true },
];

function assertValidationError(
  error: unknown,
  fieldErrorKey: string | RegExp,
  messagePattern?: RegExp,
): void {
  assert.ok(error instanceof FormCommandError, '应为 FormCommandError');
  assert.equal(error.code, FormErrorCode.VALIDATION_FAILED);
  const fieldErrors = (error.details?.fieldErrors ?? {}) as Record<string, string[]>;
  const keys = Object.keys(fieldErrors);
  if (fieldErrorKey instanceof RegExp) {
    assert.ok(
      keys.some((key) => fieldErrorKey.test(key)),
      `fieldErrors 键应匹配 ${fieldErrorKey}，实际：${keys.join(', ')}`,
    );
  } else {
    assert.ok(
      keys.includes(fieldErrorKey),
      `fieldErrors 应包含 ${fieldErrorKey}，实际：${keys.join(', ')}`,
    );
  }
  if (messagePattern !== undefined) {
    assert.ok(
      keys.some((key) => fieldErrors[key].some((message) => messagePattern.test(message))),
      `错误消息应匹配 ${messagePattern}`,
    );
  }
}

describe('validateFormFieldSet（字段安全校验）', () => {
  it('空字段集合法（新建草稿）', () => {
    const result = validateFormFieldSet([], directory);
    assert.equal(result.fields.length, 0);
  });

  it('合法字段集通过并保留结构与校验规则（required 缺省 false）', () => {
    const result = validateFormFieldSet(
      [
        { id: 'f1', title: '姓名', type: 'text', required: true },
        { id: 'f2', title: '选择', type: 'select', options: [{ id: 'a', label: 'A' }] },
      ],
      directory,
    );
    assert.equal(result.fields.length, 2);
    assert.equal(result.fields[0].required, true);
    assert.equal(result.fields[1].required, false);
  });

  it('未知字段类型拒绝（IFC-ERR-005）', () => {
    assert.throws(
      () => validateFormFieldSet([{ id: 'f1', title: 'x', type: 'rating' }], directory),
      (error: unknown) => {
        assertValidationError(error, 'fields[f1].type', /类型/);
        return true;
      },
    );
  });

  it('固定业务骨架字段（student_id）拒绝（GOV-003）', () => {
    assert.throws(
      () => validateFormFieldSet([{ id: 'student_id', title: 'x', type: 'text' }], directory),
      (error: unknown) => {
        assertValidationError(error, /fields\[student_id\]/, /骨架/);
        return true;
      },
    );
  });

  it('标题携带秘密字段特征（令牌）拒绝（GOV-003）', () => {
    assert.throws(
      () => validateFormFieldSet([{ id: 'f1', title: '访问令牌', type: 'text' }], directory),
      (error: unknown) => {
        assertValidationError(error, /fields\[f1\]\.title/, /禁止内容/);
        return true;
      },
    );
  });

  it('字段 id 不得包含脚本注入载荷（XSS）', () => {
    assert.throws(
      () =>
        validateFormFieldSet(
          [{ id: '<script>alert(1)</script>', title: 'x', type: 'text' }],
          directory,
        ),
      (error: unknown) => {
        assertValidationError(error, /fields\[/, /以小写字母开头/);
        return true;
      },
    );
  });

  it('字段 id 不得包含 SQL 注入载荷', () => {
    assert.throws(
      () =>
        validateFormFieldSet(
          [{ id: "'; DROP TABLE forms;--", title: 'x', type: 'text' }],
          directory,
        ),
      (error: unknown) => {
        assertValidationError(error, /fields\[/, /以小写字母开头/);
        return true;
      },
    );
  });

  it('重复字段 id 拒绝', () => {
    assert.throws(
      () =>
        validateFormFieldSet(
          [
            { id: 'f1', title: 'a', type: 'text' },
            { id: 'f1', title: 'b', type: 'text' },
          ],
          directory,
        ),
      (error: unknown) => {
        assertValidationError(error, /fields\[/, /重复/);
        return true;
      },
    );
  });

  it('自动带入来源不在平台批准目录内拒绝（FORM-004）', () => {
    assert.throws(
      () =>
        validateFormFieldSet(
          [{ id: 'f1', title: 'x', type: 'text', autoFill: { sourceFieldId: 'someSecret' } }],
          directory,
        ),
      (error: unknown) => {
        assertValidationError(error, /fields\[f1\]/, /目录/);
        return true;
      },
    );
  });

  it('自动带入字段服务端强制只读（客户端声明 read_write 被修正，FORM-004）', () => {
    const result = validateFormFieldSet(
      [
        {
          id: 'f1',
          title: '姓名',
          type: 'text',
          autoFill: { sourceFieldId: 'name' },
          permission: 'read_write',
        },
      ],
      directory,
    );
    assert.equal(result.fields[0].permission, 'read_only');
  });

  it('角色权限只能在对象权限内收紧，不能扩大（FORM-003）', () => {
    assert.throws(
      () =>
        validateFormFieldSet(
          [
            {
              id: 'f1',
              title: 'x',
              type: 'text',
              permission: 'read_only',
              rolePermissions: { interviewer: 'read_write' },
            },
          ],
          directory,
        ),
      (error: unknown) => {
        assertValidationError(error, /fields\[f1\]/, /收紧/);
        return true;
      },
    );
  });

  it('未知角色权限拒绝', () => {
    assert.throws(
      () =>
        validateFormFieldSet(
          [{ id: 'f1', title: 'x', type: 'text', rolePermissions: { hacker: 'read_only' } }],
          directory,
        ),
      (error: unknown) => {
        assertValidationError(error, /fields\[f1\]/, /未知角色/);
        return true;
      },
    );
  });

  it('条件引用不存在的字段拒绝（悬空条件）', () => {
    assert.throws(
      () =>
        validateFormFieldSet(
          [
            { id: 'f1', title: 'x', type: 'text' },
            {
              id: 'f2',
              title: 'y',
              type: 'text',
              condition: { sourceFieldId: 'missing', op: 'eq', value: '1' },
            },
          ],
          directory,
        ),
      (error: unknown) => {
        assertValidationError(error, /fields\[f2\]/, /条件/);
        return true;
      },
    );
  });

  it('数组字段子项递归校验（嵌套骨架字段拒绝）', () => {
    assert.throws(
      () =>
        validateFormFieldSet(
          [
            {
              id: 'arr',
              title: '数组',
              type: 'array',
              items: [{ id: 'student_id', title: '内嵌', type: 'text' }],
            },
          ],
          directory,
        ),
      (error: unknown) => {
        assertValidationError(error, /fields\[student_id\]/, /骨架/);
        return true;
      },
    );
  });
});
