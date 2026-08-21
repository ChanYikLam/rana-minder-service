/**
 * 模板/副本复制策略（form 域；FORM-010、DATA-FRM-002）。
 *
 * 复制（克隆自有表单 / 从平台模板创建 / 平台模板库物化）只含结构、字段与校验，
 * 不含提交数据、附件或内部人员信息；引用特定人员/部门的系统对象选项复制时
 * 清除（须重新配置）；副本与原表单独立演进，互不传播（FORM-010）。
 *
 * 只对字段集做纯函数变换：稳定字段 id、类型、校验、条件、权限与自动带入来源
 * 原样复制；objectType 字段的选项目录清空并保留 objectType（重新配置选项）。
 */

import type { FormFieldDefinition, FormFieldSet } from '../models/form-field';

export function copyFieldSetForTemplate(source: FormFieldSet): FormFieldSet {
  return source.map((field) => copyField(field));
}

function copyField(field: FormFieldDefinition): FormFieldDefinition {
  const copied: FormFieldDefinition = {
    id: field.id,
    title: field.title,
    type: field.type,
    required: field.required,
    ...(field.defaultValue !== undefined ? { defaultValue: field.defaultValue } : {}),
    ...(field.placeholder !== undefined ? { placeholder: field.placeholder } : {}),
    ...(field.validation !== undefined ? { validation: { ...field.validation } } : {}),
    permission: field.permission,
    ...(field.rolePermissions !== undefined
      ? { rolePermissions: { ...field.rolePermissions } }
      : {}),
    ...(field.autoFill !== undefined ? { autoFill: { ...field.autoFill } } : {}),
    ...(field.condition !== undefined ? { condition: { ...field.condition } } : {}),
    ...(field.requiredIf !== undefined ? { requiredIf: { ...field.requiredIf } } : {}),
    // 引用特定人员/部门的选项复制时清除（FORM-010：须重新配置）
    ...(field.objectType !== undefined ? { objectType: field.objectType, options: [] } : {}),
    ...(field.options !== undefined && field.objectType === undefined
      ? { options: field.options.map((option) => ({ id: option.id, label: option.label })) }
      : {}),
    ...(field.items !== undefined ? { items: field.items.map((item) => copyField(item)) } : {}),
  };
  return copied;
}
