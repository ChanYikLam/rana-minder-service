/**
 * 联合请求体字段运行时校验（interfaces/http；API-GEN-003 信封之上）。
 *
 * 所有业务字段经统一信封的 input 传入；此处对必填/类型/日期做运行时校验，
 * 缺失或非法时抛 JNT_VALIDATION（→ HTTP 400），避免 new Date(undefined) 产生
 * Invalid Date、clubIds 缺失导致 500 等隐患。
 */

import { jointErrors } from '../../application/errors';

export function requireString(input: unknown, field: string): string {
  if (typeof input !== 'string' || input.trim() === '') {
    throw jointErrors.validation(`请求字段缺失或非法：${field}`);
  }
  return input;
}

export function requireStringOrNull(input: unknown, field: string): string | null {
  if (input === undefined || input === null) {
    return null;
  }
  if (typeof input !== 'string') {
    throw jointErrors.validation(`请求字段非法：${field}`);
  }
  return input;
}

export function requireDate(input: unknown, field: string): Date {
  const raw = requireString(input, field);
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) {
    throw jointErrors.validation(`请求时间字段非法：${field}`);
  }
  return date;
}

export function requireStringArray(input: unknown, field: string): string[] {
  if (!Array.isArray(input) || input.length === 0) {
    throw jointErrors.validation(`请求字段缺失或非法（字符串数组）：${field}`);
  }
  for (const item of input) {
    if (typeof item !== 'string' || item.trim() === '') {
      throw jointErrors.validation(`请求字段包含非法元素：${field}`);
    }
  }
  return input as string[];
}

export function requireNumber(input: unknown, field: string): number {
  if (typeof input !== 'number' || Number.isNaN(input)) {
    throw jointErrors.validation(`请求字段缺失或非法（数字）：${field}`);
  }
  return input;
}

export function requireRecord(input: unknown, field: string): Record<string, unknown> {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw jointErrors.validation(`请求字段缺失或非法（对象）：${field}`);
  }
  return input as Record<string, unknown>;
}

export function requireOneOf<T extends string>(
  input: unknown,
  field: string,
  allowed: readonly T[],
): T {
  if (typeof input !== 'string' || !allowed.includes(input as T)) {
    throw jointErrors.validation(`请求字段取值非法：${field}`);
  }
  return input as T;
}
