/**
 * 动态字段定义服务端校验（form 域；DATA-FRM-003、IFC-DATA-005、ENG-003）。
 *
 * TypeScript 类型、NestJS DTO、ORM JSON 映射和客户端组件都不能替代本运行时校验
 * （DATA-FRM-003）；动态答案进权威修订前（4.1.2）与发布前均按不可变版本重验。
 *
 * 规则：
 * - 稳定字段 id：小写字母开头 [a-z0-9_]，长度 <= 64，不重复，且不得与固定业务骨架
 *   冲突（FORM-001/07、SRS-INV-010）；
 * - 字段类型必须来自冻结目录（12 种，接口清单 §13）；默认值按类型校验；
 * - 校验配置受限（长度/数值范围/安全正则）；条件用登记操作符（条件显示/条件必填），
 *   禁止任意表达式/JS（GOV-003、SEC-CTL-021）；
 * - 秘密字段（密码/验证码/令牌/密钥等）始终拒绝（GOV-003、SRS-INV-027）；
 * - 文本（标题/提示语/选项标签）拒绝脚本注入特征；
 * - 字段权限只能在对象权限内收紧（只能收紧，FORM-003、DATA-FRM-004）；
 * - 自动带入只能来自平台批准的基本资料字段目录，且服务端强制只读（FORM-004）。
 */

import { FormCommandError, FormErrorCode } from '../../application/errors';
import {
  FormFieldType,
  isFormFieldType,
  isFieldPermission,
  isFormObjectType,
  isFieldConditionOperator,
  isFormDesignerRole,
  canTighten,
  FieldPermission,
  isSkeletonFieldId,
  type FormFieldDefinition,
  type FormFieldOption,
  type FormFieldSet,
  type FormFieldCondition,
  type FieldPermission as FieldPermissionType,
} from '../models/form-field';

const FIELD_ID_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
const MAX_TITLE_LENGTH = 100;
const MAX_PLACEHOLDER_LENGTH = 200;
const MAX_OPTION_LABEL_LENGTH = 100;
const MAX_OPTION_COUNT = 100;
const MAX_PATTERN_LENGTH = 500;
const MAX_LENGTH_LIMIT = 10000;

const SECRET_KEYWORDS: readonly string[] = [
  'password',
  'pwd',
  'passwd',
  'secret',
  'token',
  'credential',
  'api_key',
  'apikey',
  '密码',
  '验证码',
  '令牌',
  '密钥',
];

const INJECTION_PATTERNS: readonly RegExp[] = [
  /<\s*(script|iframe|object|embed|style|link)/i,
  /\bon\w+\s*=/i,
  /javascript\s*:/i,
  /data\s*:\s*text\/html/i,
  /\b(alert|prompt|confirm|eval|exec)\s*\(/i,
];

export interface ProfileFieldDirectoryEntry {
  readonly fieldId: string;
  readonly label: string;
  readonly readOnly: boolean;
}

export interface FormFieldSetValidationResult {
  /** 规范化后的字段集（服务端修正项：自动带入强制只读等） */
  readonly fields: FormFieldSet;
}

/** 校验整个字段集；失败抛 IFC-ERR-005 并携带字段级 fieldErrors */
export function validateFormFieldSet(
  fields: readonly unknown[],
  profileDirectory: readonly ProfileFieldDirectoryEntry[],
): FormFieldSetValidationResult {
  const errors: Record<string, string[]> = {};
  if (!Array.isArray(fields)) {
    throw new FormCommandError(FormErrorCode.VALIDATION_FAILED, '字段集必须是数组', {
      fieldErrors: { fields: ['必须是数组'] },
    });
  }
  if (fields.length > 200) {
    throw new FormCommandError(FormErrorCode.VALIDATION_FAILED, '字段数量超过上限（200）', {
      fieldErrors: { fields: ['字段数量超过上限（200）'] },
    });
  }

  const seenIds = new Set<string>();
  const normalized: FormFieldDefinition[] = [];
  for (const raw of fields) {
    const errorKey = `fields[${fieldIdOf(raw)}]`;
    if (!isRecord(raw)) {
      errors[errorKey] = ['字段定义必须是对象'];
      continue;
    }
    const pathErrors = validateField(raw, seenIds, profileDirectory);
    if (Object.keys(pathErrors).length === 0) {
      normalized.push(normalizeField(raw, profileDirectory));
    } else {
      Object.assign(errors, pathErrors);
    }
  }

  if (Object.keys(errors).length > 0) {
    throw new FormCommandError(
      FormErrorCode.VALIDATION_FAILED,
      '字段定义不符合表单目录或安全约束',
      { fieldErrors: errors },
    );
  }
  return { fields: normalized };
}

function fieldIdOf(raw: unknown): string {
  return isRecord(raw) && typeof raw.id === 'string' ? raw.id : '?';
}

/** 校验单个字段（含 array 子表递归）；返回字段级错误映射 */
function validateField(
  raw: Record<string, unknown>,
  seenIds: Set<string>,
  profileDirectory: readonly ProfileFieldDirectoryEntry[],
): Record<string, string[]> {
  const base = `fields[${fieldIdOf(raw)}]`;
  const errors: Record<string, string[]> = {};

  if (typeof raw.id !== 'string' || !FIELD_ID_PATTERN.test(raw.id)) {
    errors[`${base}.id`] = ['必须以小写字母开头且仅含 [a-z0-9_]，长度 <= 64'];
  } else {
    if (isSkeletonFieldId(raw.id)) {
      errors[`${base}.id`] = ['与固定业务骨架字段冲突，动态字段不得替代骨架字段'];
    }
    if (seenIds.has(raw.id)) {
      errors[`${base}.id`] = ['稳定字段 id 重复'];
    }
    seenIds.add(raw.id);
  }

  if (typeof raw.title !== 'string' || raw.title.trim().length === 0) {
    errors[`${base}.title`] = ['标题必填'];
  } else if (raw.title.length > MAX_TITLE_LENGTH) {
    errors[`${base}.title`] = [`标题不能超过 ${MAX_TITLE_LENGTH} 字符`];
  } else if (hasInjection(raw.title) || hasSecret(raw.title)) {
    errors[`${base}.title`] = ['标题包含禁止内容（脚本注入或秘密字段特征）'];
  }

  if (typeof raw.type !== 'string' || !isFormFieldType(raw.type)) {
    errors[`${base}.type`] = ['字段类型不在登记目录内'];
  }

  if (raw.required !== undefined && typeof raw.required !== 'boolean') {
    errors[`${base}.required`] = ['required 必须是布尔值'];
  }

  if (raw.placeholder !== undefined) {
    if (typeof raw.placeholder !== 'string' || raw.placeholder.length > MAX_PLACEHOLDER_LENGTH) {
      errors[`${base}.placeholder`] = [
        `提示语必须是非空字符串且不超过 ${MAX_PLACEHOLDER_LENGTH} 字符`,
      ];
    } else if (hasInjection(raw.placeholder)) {
      errors[`${base}.placeholder`] = ['提示语包含禁止内容'];
    }
  }

  const type = typeof raw.type === 'string' ? raw.type : null;
  const defaultValueError = validateDefaultValue(type, raw.defaultValue);
  if (defaultValueError !== null) {
    errors[`${base}.defaultValue`] = [defaultValueError];
  }

  if (raw.options !== undefined) {
    const optionErrors = validateOptions(type, raw.options, base);
    Object.assign(errors, optionErrors);
  }

  if (raw.objectType !== undefined) {
    if (type !== FormFieldType.SELECT) {
      errors[`${base}.objectType`] = ['系统对象选择仅适用于 select 字段'];
    } else if (typeof raw.objectType !== 'string' || !isFormObjectType(raw.objectType)) {
      errors[`${base}.objectType`] = ['对象类型必须是 person/club/department'];
    }
  }

  const validationErrors = validateValidationConfig(type, raw.validation, base);
  Object.assign(errors, validationErrors);

  const permissionErrors = validatePermission(raw.permission, base);
  Object.assign(errors, permissionErrors);
  const rolePermissionErrors = validateRolePermissions(raw, base);
  Object.assign(errors, rolePermissionErrors);

  if (raw.autoFill !== undefined) {
    const autoFillErrors = validateAutoFill(raw.autoFill, profileDirectory, base);
    Object.assign(errors, autoFillErrors);
  }

  if (raw.condition !== undefined) {
    const conditionErrors = validateCondition(raw.condition, raw, base, 'condition');
    Object.assign(errors, conditionErrors);
  }
  if (raw.requiredIf !== undefined) {
    const conditionErrors = validateCondition(raw.requiredIf, raw, base, 'requiredIf');
    Object.assign(errors, conditionErrors);
  }

  if (raw.items !== undefined) {
    if (type !== FormFieldType.ARRAY) {
      errors[`${base}.items`] = ['子表仅适用于 array 字段'];
    } else if (!Array.isArray(raw.items) || raw.items.length === 0) {
      errors[`${base}.items`] = ['array 字段必须包含非空子表字段'];
    } else if (raw.items.length > 50) {
      errors[`${base}.items`] = ['子表字段数量超过上限（50）'];
    } else {
      for (const item of raw.items) {
        if (!isRecord(item)) {
          errors[`${base}.items`] = ['子表字段定义必须是对象'];
          continue;
        }
        if (item.type === FormFieldType.ARRAY) {
          errors[`${base}.items`] = ['子表不允许嵌套 array（最多一层）'];
          continue;
        }
        if (item.autoFill !== undefined) {
          errors[`${base}.items`] = ['子表字段不允许自动带入'];
          continue;
        }
        const itemErrors = validateField(item, seenIds, profileDirectory);
        Object.assign(errors, itemErrors);
      }
    }
  }

  return errors;
}

function normalizeField(
  raw: Record<string, unknown>,
  profileDirectory: readonly ProfileFieldDirectoryEntry[],
): FormFieldDefinition {
  const permission = isFieldPermission(raw.permission)
    ? (raw.permission as FieldPermissionType)
    : FieldPermission.READ_WRITE;
  const autoFill =
    isRecord(raw.autoFill) && typeof raw.autoFill.sourceFieldId === 'string'
      ? { sourceFieldId: raw.autoFill.sourceFieldId }
      : undefined;
  const isAutoFilled =
    autoFill !== undefined &&
    isAutoFillSource(raw.autoFill as Record<string, unknown>, profileDirectory);
  const normalized: FormFieldDefinition = {
    id: String(raw.id),
    title: String(raw.title),
    type: raw.type as FormFieldDefinition['type'],
    required: raw.required === true,
    ...(raw.defaultValue !== undefined ? { defaultValue: raw.defaultValue } : {}),
    ...(raw.placeholder !== undefined ? { placeholder: String(raw.placeholder) } : {}),
    ...(isRecord(raw.validation)
      ? { validation: raw.validation as FormFieldDefinition['validation'] }
      : {}),
    // 自动带入字段服务端强制只读（FORM-004，客户端声明一律被修正）
    permission: isAutoFilled ? FieldPermission.READ_ONLY : permission,
    ...(raw.options !== undefined ? { options: normalizeOptions(raw.options) } : {}),
    ...(typeof raw.objectType === 'string' ? { objectType: raw.objectType as never } : {}),
    ...(isRecord(raw.rolePermissions)
      ? { rolePermissions: raw.rolePermissions as FormFieldDefinition['rolePermissions'] }
      : {}),
    ...(autoFill !== undefined ? { autoFill } : {}),
    ...(isRecord(raw.condition)
      ? { condition: raw.condition as unknown as FormFieldCondition }
      : {}),
    ...(isRecord(raw.requiredIf)
      ? { requiredIf: raw.requiredIf as unknown as FormFieldCondition }
      : {}),
    ...(raw.type === FormFieldType.ARRAY && Array.isArray(raw.items)
      ? {
          items: raw.items.map((item) =>
            normalizeField(item as Record<string, unknown>, profileDirectory),
          ),
        }
      : {}),
  };
  return normalized;
}

function validateDefaultValue(type: string | null, value: unknown): string | null {
  if (value === undefined) {
    return null;
  }
  switch (type) {
    case FormFieldType.TEXT:
    case FormFieldType.TEXTAREA:
      if (typeof value !== 'string') {
        return '文本字段默认值必须是字符串';
      }
      if (hasInjection(value)) {
        return '默认值包含禁止内容';
      }
      return null;
    case FormFieldType.NUMBER:
      return typeof value === 'number' && Number.isFinite(value)
        ? null
        : '数字字段默认值必须是有限数值';
    case FormFieldType.CHECKBOX:
      return typeof value === 'boolean' ? null : '是/否字段默认值必须是布尔值';
    case FormFieldType.DATE:
      return /^\d{4}-\d{2}-\d{2}$/.test(String(value)) ? null : '日期默认值必须是 YYYY-MM-DD';
    case FormFieldType.DATETIME:
      return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/.test(
        String(value),
      )
        ? null
        : '日期时间默认值必须是 ISO-8601 格式';
    case FormFieldType.SELECT:
    case FormFieldType.RADIO:
    case FormFieldType.MULTI_SELECT:
      return validateOptionReference(type, value);
    case FormFieldType.FILE:
    case FormFieldType.IMAGE:
    case FormFieldType.ARRAY:
      return '该字段类型不允许默认值';
    default:
      return '未知字段类型';
  }
}

function validateOptionReference(type: string, value: unknown): string | null {
  if (type === FormFieldType.MULTI_SELECT) {
    if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
      return '多选默认值必须是选项 id 字符串数组';
    }
    return null;
  }
  return typeof value === 'string' ? null : '单选默认值必须是选项 id 字符串';
}

function validateOptions(
  type: string | null,
  options: unknown,
  base: string,
): Record<string, string[]> {
  const errors: Record<string, string[]> = {};
  if (
    type !== FormFieldType.SELECT &&
    type !== FormFieldType.MULTI_SELECT &&
    type !== FormFieldType.RADIO
  ) {
    errors[`${base}.options`] = ['选项目录仅适用于 select/multi_select/radio 字段'];
    return errors;
  }
  if (!Array.isArray(options)) {
    errors[`${base}.options`] = ['选项目录必须是数组'];
    return errors;
  }
  if (options.length === 0 || options.length > MAX_OPTION_COUNT) {
    errors[`${base}.options`] = [`选项目录数量必须为 1~${MAX_OPTION_COUNT}`];
    return errors;
  }
  const ids = new Set<string>();
  for (const option of options) {
    if (!isRecord(option)) {
      errors[`${base}.options`] = ['选项必须是对象'];
      continue;
    }
    if (typeof option.id !== 'string' || !FIELD_ID_PATTERN.test(option.id)) {
      errors[`${base}.options`] = ['选项 id 格式不正确'];
    } else if (ids.has(option.id)) {
      errors[`${base}.options`] = ['选项 id 重复'];
    }
    ids.add(String(option.id));
    if (
      typeof option.label !== 'string' ||
      option.label.trim().length === 0 ||
      option.label.length > MAX_OPTION_LABEL_LENGTH
    ) {
      errors[`${base}.options`] = [
        `选项标签必须是非空字符串且不超过 ${MAX_OPTION_LABEL_LENGTH} 字符`,
      ];
    } else if (hasInjection(String(option.label))) {
      errors[`${base}.options`] = ['选项标签包含禁止内容'];
    }
  }
  return errors;
}

function normalizeOptions(options: unknown): FormFieldOption[] {
  return (options as { id: string; label: string }[]).map((o) => ({ id: o.id, label: o.label }));
}

function validateValidationConfig(
  type: string | null,
  validation: unknown,
  base: string,
): Record<string, string[]> {
  const errors: Record<string, string[]> = {};
  if (validation === undefined) {
    return errors;
  }
  if (!isRecord(validation)) {
    errors[`${base}.validation`] = ['校验配置必须是对象'];
    return errors;
  }
  if (validation.minLength !== undefined || validation.maxLength !== undefined) {
    if (type !== FormFieldType.TEXT && type !== FormFieldType.TEXTAREA) {
      errors[`${base}.validation`] = ['长度校验仅适用于文本字段'];
    } else {
      const minLength = nonNegativeInt(validation.minLength);
      const maxLength = nonNegativeInt(validation.maxLength);
      if (minLength === null || maxLength === null) {
        errors[`${base}.validation`] = ['长度校验必须是 0~10000 的整数'];
      } else if (minLength > maxLength) {
        errors[`${base}.validation`] = ['最小长度不能大于最大长度'];
      }
    }
  }
  if (validation.min !== undefined || validation.max !== undefined) {
    if (type !== FormFieldType.NUMBER) {
      errors[`${base}.validation`] = ['数值范围校验仅适用于数字字段'];
    } else if (
      (validation.min !== undefined && !Number.isFinite(Number(validation.min))) ||
      (validation.max !== undefined && !Number.isFinite(Number(validation.max)))
    ) {
      errors[`${base}.validation`] = ['数值范围必须是有限数值'];
    }
  }
  if (validation.pattern !== undefined) {
    if (type !== FormFieldType.TEXT && type !== FormFieldType.TEXTAREA) {
      errors[`${base}.validation`] = ['正则校验仅适用于文本字段'];
    } else if (
      typeof validation.pattern !== 'string' ||
      validation.pattern.length > MAX_PATTERN_LENGTH
    ) {
      errors[`${base}.validation`] = [`正则表达式不能超过 ${MAX_PATTERN_LENGTH} 字符`];
    } else {
      try {
        new RegExp(validation.pattern);
      } catch {
        errors[`${base}.validation`] = ['正则表达式无法编译（只接受安全的正则格式校验）'];
      }
    }
  }
  return errors;
}

function validatePermission(permission: unknown, base: string): Record<string, string[]> {
  const errors: Record<string, string[]> = {};
  if (permission !== undefined && !isFieldPermission(permission)) {
    errors[`${base}.permission`] = ['字段权限必须是 read_write/read_only/hidden'];
    return errors;
  }
  return errors;
}

function validateRolePermissions(
  raw: Record<string, unknown>,
  base: string,
): Record<string, string[]> {
  const errors: Record<string, string[]> = {};
  if (raw.rolePermissions === undefined) {
    return errors;
  }
  if (!isRecord(raw.rolePermissions)) {
    errors[`${base}.rolePermissions`] = ['角色权限必须是对象'];
    return errors;
  }
  const objectPermission = isFieldPermission(raw.permission)
    ? (raw.permission as FieldPermissionType)
    : FieldPermission.READ_WRITE;
  for (const [role, value] of Object.entries(raw.rolePermissions)) {
    if (!isFormDesignerRole(role)) {
      errors[`${base}.rolePermissions`] = [`未知角色：${role}`];
      continue;
    }
    if (!isFieldPermission(value)) {
      errors[`${base}.rolePermissions`] = [`角色 ${role} 权限必须是 read_write/read_only/hidden`];
      continue;
    }
    if (!canTighten(objectPermission, value)) {
      errors[`${base}.rolePermissions`] = [
        `角色 ${role} 权限只能在对象权限（${objectPermission}）内收紧，不能扩大`,
      ];
    }
  }
  return errors;
}

function validateAutoFill(
  autoFill: unknown,
  profileDirectory: readonly ProfileFieldDirectoryEntry[],
  base: string,
): Record<string, string[]> {
  const errors: Record<string, string[]> = {};
  if (!isRecord(autoFill) || typeof autoFill.sourceFieldId !== 'string') {
    errors[`${base}.autoFill`] = ['自动带入必须声明 sourceFieldId'];
    return errors;
  }
  if (!isAutoFillSource(autoFill, profileDirectory)) {
    errors[`${base}.autoFill`] = [
      `自动带入来源（${autoFill.sourceFieldId}）不在平台批准的基本资料字段目录内`,
    ];
  }
  return errors;
}

function isAutoFillSource(
  autoFill: Record<string, unknown>,
  profileDirectory: readonly ProfileFieldDirectoryEntry[],
): boolean {
  if (typeof autoFill.sourceFieldId !== 'string') {
    return false;
  }
  return profileDirectory.some((entry) => entry.fieldId === autoFill.sourceFieldId);
}

function validateCondition(
  condition: unknown,
  raw: Record<string, unknown>,
  base: string,
  key: string,
): Record<string, string[]> {
  const errors: Record<string, string[]> = {};
  if (!isRecord(condition)) {
    errors[`${base}.${key}`] = ['条件必须是对象'];
    return errors;
  }
  const errorKey = `${base}.${key}`;
  if (typeof condition.fieldId !== 'string' || !FIELD_ID_PATTERN.test(condition.fieldId)) {
    errors[errorKey] = ['条件字段标识格式不正确'];
  } else if (condition.fieldId === raw.id) {
    errors[errorKey] = ['条件不能引用字段自身'];
  } else if (!isSiblingFieldId(condition.fieldId, raw)) {
    errors[errorKey] = ['条件只能引用同一表单（或同一子表）内已声明的稳定字段'];
  }
  if (typeof condition.operator !== 'string' || !isFieldConditionOperator(condition.operator)) {
    errors[errorKey] = ['条件操作符不在登记目录内'];
  } else {
    const operator = condition.operator;
    const needsValue = operator === 'equals' || operator === 'not_equals';
    const needsArray = operator === 'in' || operator === 'not_in';
    const forbidsValue = operator === 'empty' || operator === 'not_empty';
    if (needsValue && !isPrimitive(condition.value)) {
      errors[errorKey] = ['equals/not_equals 条件必须携带原始值'];
    }
    if (
      needsArray &&
      (!Array.isArray(condition.value) || condition.value.some((v) => !isPrimitive(v)))
    ) {
      errors[errorKey] = ['in/not_in 条件必须携带原始值数组'];
    }
    if (forbidsValue && condition.value !== undefined) {
      errors[errorKey] = ['empty/not_empty 条件不允许携带值'];
    }
  }
  return errors;
}

/** 同级字段集合（顶层字段或同一子表内的字段） */
function isSiblingFieldId(fieldId: string, raw: Record<string, unknown>): boolean {
  if (Array.isArray(raw.items) && raw.items.some((item) => isRecord(item) && item.id === fieldId)) {
    return true;
  }
  return false;
}

function nonNegativeInt(value: unknown): number | null {
  return typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= MAX_LENGTH_LIMIT
    ? value
    : null;
}

function isPrimitive(value: unknown): boolean {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}

function hasSecret(text: string): boolean {
  const lower = text.toLowerCase();
  return SECRET_KEYWORDS.some((keyword) => lower.includes(keyword));
}

function hasInjection(text: string): boolean {
  return INJECTION_PATTERNS.some((pattern) => pattern.test(text));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
