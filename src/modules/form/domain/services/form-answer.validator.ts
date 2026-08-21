/**
 * 表单答案值校验（form 域；FORM-002、DATA-FRM-003、IFC-DATA-005）。
 *
 * 提交/修订落库前按不可变版本重验（动态答案不信任客户端类型）：
 * - 必填字段缺失 → IFC-ERR-005；类型不匹配、选项越界、子表结构错误同样拒绝；
 * - hidden 字段不接收提交值（提交者不应写入隐藏字段）；
 * - 文本长度按字段 validation.maxLength 约束；选项值必须落在版本选项目录内；
 * - 子表（array）逐行递归校验；条件必填（requiredIf）依据条件是否命中。
 */

import { FormCommandError, FormErrorCode } from '../../application/errors';
import { FormFieldType, type FormFieldDefinition, type FormFieldSet } from '../models/form-field';
import type { FormAnswerRow } from '../models/form-submission';

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const DATETIME_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;

/**
 * 剔除版本定义中 hidden 字段的值（含子表行内 hidden 字段）。
 * 校验器不接收 hidden 字段提交值，但客户端仍可能注入这些字段，落库前必须清理，
 * 防止隐藏字段被服务端忽略校验后写入提交记录（DATA-FRM-003 数据完整性）。
 */
export function stripHiddenFieldValues(
  fields: FormFieldSet,
  values: Record<string, unknown>,
): Record<string, unknown> {
  const hiddenIds = new Set(fields.filter((f) => f.permission === 'hidden').map((f) => f.id));
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(values)) {
    if (hiddenIds.has(key)) {
      continue;
    }
    const field = fields.find((f) => f.id === key);
    if (field?.type === FormFieldType.ARRAY && Array.isArray(value)) {
      result[key] = stripHiddenFromRows(field, value as FormAnswerRow[]);
    } else {
      result[key] = value;
    }
  }
  return result;
}

function stripHiddenFromRows(field: FormFieldDefinition, rows: FormAnswerRow[]): FormAnswerRow[] {
  const itemHidden = new Set(
    (field.items ?? []).filter((i) => i.permission === 'hidden').map((i) => i.id),
  );
  return rows.map((row) => {
    const cleaned: Record<string, unknown> = {};
    for (const [itemId, itemValue] of Object.entries(row)) {
      if (itemHidden.has(itemId)) {
        continue;
      }
      cleaned[itemId] = itemValue;
    }
    return cleaned as FormAnswerRow;
  });
}

export function validateFormAnswer(fields: FormFieldSet, values: Record<string, unknown>): void {
  const errors: Record<string, string[]> = {};
  for (const field of fields) {
    if (field.permission === 'hidden') {
      continue;
    }
    const raw = values[field.id];
    if (isMissing(raw, field.type)) {
      if (field.required || isRequiredByCondition(field, values)) {
        errors[field.id] = ['必填字段未填写'];
      }
      continue;
    }
    const typeError = validateValueType(field, raw);
    if (typeError !== null) {
      errors[field.id] = [typeError];
      continue;
    }
    const optionError = validateOptions(field, raw);
    if (optionError !== null) {
      errors[field.id] = [optionError];
    }
    const lengthError = validateLength(field, raw);
    if (lengthError !== null) {
      errors[field.id] = [lengthError];
    }
    if (field.type === FormFieldType.ARRAY && Array.isArray(raw)) {
      validateRows(field, raw as FormAnswerRow[], errors);
    }
  }
  if (Object.keys(errors).length > 0) {
    throw new FormCommandError(FormErrorCode.VALIDATION_FAILED, '表单答案不符合字段约束', {
      fieldErrors: errors,
    });
  }
}

function isMissing(value: unknown, type: FormFieldType): boolean {
  switch (type) {
    case FormFieldType.TEXT:
    case FormFieldType.TEXTAREA:
      return typeof value !== 'string' || value.trim().length === 0;
    case FormFieldType.NUMBER:
    case FormFieldType.DATE:
    case FormFieldType.DATETIME:
    case FormFieldType.SELECT:
    case FormFieldType.RADIO:
    case FormFieldType.FILE:
    case FormFieldType.IMAGE:
    case FormFieldType.CHECKBOX:
      return value === null || value === undefined;
    case FormFieldType.MULTI_SELECT:
      return !Array.isArray(value) || value.length === 0;
    case FormFieldType.ARRAY:
      return !Array.isArray(value) || value.length === 0;
    default:
      return value === null || value === undefined;
  }
}

function validateValueType(field: FormFieldDefinition, value: unknown): string | null {
  switch (field.type) {
    case FormFieldType.TEXT:
    case FormFieldType.TEXTAREA:
      return typeof value === 'string' ? null : '文本字段值必须是字符串';
    case FormFieldType.NUMBER:
      return typeof value === 'number' && Number.isFinite(value)
        ? null
        : '数字字段值必须是有限数值';
    case FormFieldType.SELECT:
    case FormFieldType.RADIO:
    case FormFieldType.FILE:
    case FormFieldType.IMAGE:
      return typeof value === 'string' ? null : '该字段值必须是字符串';
    case FormFieldType.MULTI_SELECT:
      return Array.isArray(value) && value.every((v) => typeof v === 'string')
        ? null
        : '多选值必须是选项 id 字符串数组';
    case FormFieldType.CHECKBOX:
      return typeof value === 'boolean' ? null : '是/否字段值必须是布尔值';
    case FormFieldType.DATE:
      return typeof value === 'string' && DATE_PATTERN.test(value)
        ? null
        : '日期值必须是 YYYY-MM-DD';
    case FormFieldType.DATETIME:
      return typeof value === 'string' && DATETIME_PATTERN.test(value)
        ? null
        : '日期时间值必须是 ISO-8601 格式';
    case FormFieldType.ARRAY:
      return Array.isArray(value) ? null : '子表值必须是数组';
    default:
      return '未知字段类型';
  }
}

function validateOptions(field: FormFieldDefinition, value: unknown): string | null {
  if (
    field.type !== FormFieldType.SELECT &&
    field.type !== FormFieldType.RADIO &&
    field.type !== FormFieldType.MULTI_SELECT
  ) {
    return null;
  }
  const ids = new Set((field.options ?? []).map((o) => o.id));
  if (field.type === FormFieldType.MULTI_SELECT) {
    return (value as string[]).every((v) => ids.has(v)) ? null : '选项值不在版本选项目录内';
  }
  return ids.has(value as string) ? null : '选项值不在版本选项目录内';
}

function validateLength(field: FormFieldDefinition, value: unknown): string | null {
  if (
    (field.type === FormFieldType.TEXT || field.type === FormFieldType.TEXTAREA) &&
    typeof value === 'string' &&
    field.validation?.maxLength != null &&
    value.length > field.validation.maxLength
  ) {
    return `超过最大长度 ${field.validation.maxLength}`;
  }
  return null;
}

function validateRows(
  field: FormFieldDefinition,
  rows: FormAnswerRow[],
  errors: Record<string, string[]>,
): void {
  const items = field.items ?? [];
  rows.forEach((row, index) => {
    for (const item of items) {
      const key = `${field.id}[${index}].${item.id}`;
      const raw = (row as Record<string, unknown>)[item.id];
      if (isMissing(raw, item.type)) {
        if (item.required) {
          errors[key] = ['必填字段未填写'];
        }
        continue;
      }
      const typeError = validateValueType(item, raw);
      if (typeError !== null) {
        errors[key] = [typeError];
      }
    }
  });
}

function isRequiredByCondition(
  field: FormFieldDefinition,
  values: Record<string, unknown>,
): boolean {
  const condition = field.requiredIf;
  if (condition === undefined) {
    return false;
  }
  const actual = values[condition.fieldId];
  const expected = condition.value;
  switch (condition.operator) {
    case 'equals':
      return actual === expected;
    case 'not_equals':
      return actual !== expected;
    case 'in':
      return Array.isArray(expected) && (expected as unknown[]).includes(actual);
    case 'not_in':
      return Array.isArray(expected) && !(expected as unknown[]).includes(actual);
    case 'empty':
      return actual === null || actual === undefined || actual === '';
    case 'not_empty':
      return !(actual === null || actual === undefined || actual === '');
    default:
      return false;
  }
}
