/**
 * 安全控制独立验证：SEC-CTL-020 / SEC-CTL-021（动态表单骨架与 JSONB 答案约束）。
 *
 * 权威来源：docs/specification/安全设计与实现级威胁模型-v1.0.md §5、§12。
 *
 * 验证路径（真实纯函数，无 pg/jose 依赖）：
 * - src/modules/form/domain/services/form-answer.validator.ts
 *   （类型混淆/选项越界/超长拒绝；hidden 字段服务端剔除）
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  stripHiddenFieldValues,
  validateFormAnswer,
} from '../../src/modules/form/domain/services/form-answer.validator';
import type { FormFieldSet } from '../../src/modules/form/domain/models/form-field';

const FIELDS: FormFieldSet = [
  {
    id: 'name',
    title: '姓名',
    type: 'text',
    required: true,
    permission: 'read_write',
    validation: { maxLength: 4 },
  },
  {
    id: 'grade',
    title: '年级',
    type: 'select',
    required: true,
    permission: 'read_write',
    options: [
      { id: 'g1', label: '大一' },
      { id: 'g2', label: '大二' },
    ],
  },
];

function expectFieldError(fn: () => void, fieldKey: string): string[] {
  try {
    fn();
    assert.fail(`应当拒绝并携带 fieldErrors.${fieldKey}`);
  } catch (err) {
    const details = (err as { details?: { fieldErrors?: Record<string, string[]> } })['details'];
    const errors = details?.fieldErrors ?? {};
    assert.ok(
      errors[fieldKey] !== undefined,
      `缺少 fieldErrors.${fieldKey}：${JSON.stringify(errors)}`,
    );
    return errors[fieldKey];
  }
}

describe('SEC-CTL-020 JSONB 答案按不可变版本强类型重验', () => {
  it('SEC-CTL-020：类型混淆拒绝——选项字段收到数字值', () => {
    const messages = expectFieldError(
      () => validateFormAnswer(FIELDS, { name: '张三', grade: 123 as unknown as string }),
      'grade',
    );
    assert.ok(messages.join().includes('字符串'));
  });

  it('SEC-CTL-020：选项越界拒绝——答案值不在版本选项目录内', () => {
    const messages = expectFieldError(
      () => validateFormAnswer(FIELDS, { name: '张三', grade: 'gX' }),
      'grade',
    );
    assert.ok(messages.join().includes('选项目录'));
  });

  it('SEC-CTL-020：越界长度拒绝——文本超过字段 maxLength 约束', () => {
    const messages = expectFieldError(
      () => validateFormAnswer(FIELDS, { name: '12345', grade: 'g1' }),
      'name',
    );
    assert.ok(messages.join().includes('最大长度'));
  });

  it('SEC-CTL-020：必填缺失拒绝；合法答案通过', () => {
    expectFieldError(() => validateFormAnswer(FIELDS, { grade: 'g1' }), 'name');
    assert.doesNotThrow(() => validateFormAnswer(FIELDS, { name: '张三', grade: 'g1' }));
  });
});

describe('SEC-CTL-021 隐藏字段由服务端重算，客户端回传值不入库', () => {
  const withHidden: FormFieldSet = [
    ...FIELDS,
    {
      id: 'internal_note',
      title: '内部备注',
      type: 'text',
      required: false,
      permission: 'hidden',
    },
    {
      id: 'experiences',
      title: '经历',
      type: 'array',
      required: false,
      permission: 'read_write',
      items: [
        { id: 'row_note', title: '行内备注', type: 'text', required: false, permission: 'hidden' },
        { id: 'org', title: '组织', type: 'text', required: false, permission: 'read_write' },
      ],
    },
  ];

  it('SEC-CTL-021：顶层 hidden 字段提交值被整体剔除', () => {
    const cleaned = stripHiddenFieldValues(withHidden, {
      name: '张三',
      grade: 'g1',
      internal_note: '客户端伪造的内部结论',
    });
    assert.equal(cleaned['internal_note'], undefined);
    assert.equal(cleaned['name'], '张三');
  });

  it('SEC-CTL-021：子表行内 hidden 字段同样剔除，普通字段保留', () => {
    const cleaned = stripHiddenFieldValues(withHidden, {
      experiences: [{ org: '社团A', row_note: '注入的隐藏行值' }, { org: '社团B' }],
    }) as { experiences: Array<Record<string, unknown>> };
    assert.equal(cleaned.experiences[0]['row_note'], undefined);
    assert.equal(cleaned.experiences[0]['org'], '社团A');
    assert.deepEqual(cleaned.experiences[1], { org: '社团B' });
  });

  it('SEC-CTL-021：validateFormAnswer 不接收 hidden 字段（跳过校验即不承认其输入地位）', () => {
    assert.doesNotThrow(() =>
      validateFormAnswer(withHidden, {
        name: '张三',
        grade: 'g1',
        internal_note: '任何值',
      }),
    );
  });
});
