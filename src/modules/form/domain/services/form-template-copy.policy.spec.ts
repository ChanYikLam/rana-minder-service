/**
 * 模板/副本复制策略测试（FORM-010：只复制结构，不含数据；对象选项清空；
 * 副本独立演进）。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { copyFieldSetForTemplate } from './form-template-copy.policy';
import type { FormFieldSet } from '../models/form-field';

describe('copyFieldSetForTemplate（复制策略）', () => {
  it('普通字段结构原样复制', () => {
    const source: FormFieldSet = [
      {
        id: 'f1',
        title: '姓名',
        type: 'text',
        required: true,
        permission: 'read_write',
        placeholder: '请输入',
      },
    ];
    const copied = copyFieldSetForTemplate(source);
    assert.deepEqual(copied, source);
    assert.notEqual(copied, source);
    assert.notEqual(copied[0], source[0]);
  });

  it('objectType 字段保留类型但清空选项（须重新配置，FORM-010）', () => {
    const source: FormFieldSet = [
      {
        id: 'obj',
        title: '选择人员',
        type: 'select',
        required: false,
        permission: 'read_write',
        objectType: 'person',
        options: [{ id: 'user-1', label: '张三' }],
      },
    ];
    const copied = copyFieldSetForTemplate(source);
    assert.equal(copied[0].objectType, 'person');
    assert.deepEqual(copied[0].options, []);
  });

  it('非对象字段的选项复制（不含敏感载荷）', () => {
    const source: FormFieldSet = [
      {
        id: 'sel',
        title: '选择',
        type: 'select',
        required: false,
        permission: 'read_write',
        options: [{ id: 'a', label: 'A' }],
      },
    ];
    const copied = copyFieldSetForTemplate(source);
    assert.deepEqual(copied[0].options, [{ id: 'a', label: 'A' }]);
  });

  it('数组字段递归复制且不共享引用', () => {
    const source: FormFieldSet = [
      {
        id: 'arr',
        title: '数组',
        type: 'array',
        required: false,
        permission: 'read_write',
        items: [
          { id: 'inner', title: '内嵌', type: 'text', required: false, permission: 'read_write' },
        ],
      },
    ];
    const copied = copyFieldSetForTemplate(source);
    assert.deepEqual(copied, source);
    assert.notEqual(copied[0].items, source[0].items);
    assert.notEqual(copied[0].items![0], source[0].items![0]);
  });

  it('副本修改不影响原字段集（独立演进）', () => {
    const source: FormFieldSet = [
      {
        id: 'obj',
        title: '选择',
        type: 'select',
        required: false,
        permission: 'read_write',
        objectType: 'person',
        options: [{ id: 'u-1', label: '用户' }],
      },
    ];
    const copied = copyFieldSetForTemplate(source);
    assert.notEqual(copied[0], source[0]);
    assert.notEqual(copied[0].options, source[0].options);
    assert.notEqual(copied[0].options![0], source[0].options![0]);
  });
});
