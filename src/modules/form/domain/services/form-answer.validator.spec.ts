/**
 * 表单答案值校验（FORM-002）。
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { FormFieldType, type FormFieldSet } from '../models/form-field';
import { validateFormAnswer } from './form-answer.validator';

const FIELDS: FormFieldSet = [
  { id: 'name', title: '姓名', type: FormFieldType.TEXT, required: true, permission: 'read_write' },
  {
    id: 'level',
    title: '年级',
    type: FormFieldType.SELECT,
    required: true,
    permission: 'read_write',
    options: [
      { id: 'g1', label: '大一' },
      { id: 'g2', label: '大二' },
    ],
  },
  {
    id: 'bio',
    title: '简介',
    type: FormFieldType.TEXTAREA,
    required: false,
    permission: 'read_write',
  },
  {
    id: 'skills',
    title: '技能',
    type: FormFieldType.MULTI_SELECT,
    required: false,
    permission: 'read_write',
    options: [
      { id: 'a', label: 'A' },
      { id: 'b', label: 'B' },
    ],
  },
  { id: 'secret', title: '隐藏', type: FormFieldType.TEXT, required: false, permission: 'hidden' },
  {
    id: 'exp',
    title: '经历',
    type: FormFieldType.ARRAY,
    required: false,
    permission: 'read_write',
    items: [
      {
        id: 'org',
        title: '组织',
        type: FormFieldType.TEXT,
        required: true,
        permission: 'read_write',
      },
    ],
  },
];

describe('validateFormAnswer（FORM-002）', () => {
  it('必填缺失 → 拒绝', () => {
    assert.throws(
      () => validateFormAnswer(FIELDS, { level: 'g1' }),
      (err: Error) => err.message.includes('表单答案不符合字段约束'),
    );
  });

  it('选项越界 → 拒绝', () => {
    assert.throws(() => validateFormAnswer(FIELDS, { name: 'x', level: 'g9' }));
  });

  it('类型不匹配 → 拒绝', () => {
    assert.throws(() => validateFormAnswer(FIELDS, { name: 123, level: 'g1' }));
  });

  it('hidden 字段忽略提交值（不报错）', () => {
    assert.doesNotThrow(() =>
      validateFormAnswer(FIELDS, { name: 'x', level: 'g1', secret: 'leak' }),
    );
  });

  it('多选值须落在选项目录', () => {
    assert.throws(() => validateFormAnswer(FIELDS, { name: 'x', level: 'g1', skills: ['z'] }));
    assert.doesNotThrow(() =>
      validateFormAnswer(FIELDS, { name: 'x', level: 'g1', skills: ['a', 'b'] }),
    );
  });

  it('子表必填项缺失 → 拒绝', () => {
    assert.throws(() => validateFormAnswer(FIELDS, { name: 'x', level: 'g1', exp: [{ org: '' }] }));
  });

  it('合法答案通过', () => {
    assert.doesNotThrow(() =>
      validateFormAnswer(FIELDS, {
        name: '张三',
        level: 'g1',
        bio: '你好',
        skills: ['a'],
        exp: [{ org: '科协' }],
      }),
    );
  });
});
