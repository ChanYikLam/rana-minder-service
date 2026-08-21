/**
 * 表单域请求信封解析（API-GEN-003；接口清单 §13）。
 *
 * 规则（与 identity 信封同构）：POST/PUT 统一信封，业务字段只读 input，
 * 不兼容平铺写法；信封顶层只允许 action/targetId/expectedVersion/
 * idempotencyKey/input 五键，未知键 → 422 IFC-ERR-005；请求体非对象 →
 * 400 IFC-ERR-017；expectedVersion 必须是正整数 → 422 IFC-ERR-005。
 */

import { FormCommandError, FormErrorCode } from '../../application/errors';
import type { ApiRequestEnvelope } from '../../../../common/contracts/api-envelope';

const ENVELOPE_KEYS = new Set(['action', 'targetId', 'expectedVersion', 'idempotencyKey', 'input']);

export function parseFormRequestEnvelope(
  body: unknown,
): ApiRequestEnvelope<Record<string, unknown>> {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new FormCommandError(FormErrorCode.BAD_REQUEST, '请求体格式不正确（应为 JSON 对象信封）');
  }
  const record = body as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!ENVELOPE_KEYS.has(key)) {
      throw new FormCommandError(FormErrorCode.VALIDATION_FAILED, '请求信封包含未知字段', {
        fieldErrors: { [key]: ['未知信封字段，业务字段应位于 input 内'] },
      });
    }
  }
  if (record.expectedVersion !== undefined && !Number.isInteger(record.expectedVersion)) {
    throw new FormCommandError(FormErrorCode.VALIDATION_FAILED, 'expectedVersion 必须是整数', {
      fieldErrors: { expectedVersion: ['必须是整数'] },
    });
  }
  if (record.expectedVersion !== undefined && Number(record.expectedVersion) <= 0) {
    throw new FormCommandError(FormErrorCode.VALIDATION_FAILED, 'expectedVersion 必须是正整数', {
      fieldErrors: { expectedVersion: ['必须是正整数'] },
    });
  }
  if (
    record.input !== undefined &&
    (record.input === null || typeof record.input !== 'object' || Array.isArray(record.input))
  ) {
    throw new FormCommandError(FormErrorCode.VALIDATION_FAILED, 'input 必须是对象', {
      fieldErrors: { input: ['必须是对象'] },
    });
  }
  return {
    ...(record.action !== undefined ? { action: String(record.action) } : {}),
    ...(record.targetId !== undefined ? { targetId: String(record.targetId) } : {}),
    ...(record.expectedVersion !== undefined
      ? { expectedVersion: record.expectedVersion as number }
      : {}),
    ...(record.idempotencyKey !== undefined
      ? { idempotencyKey: String(record.idempotencyKey) }
      : {}),
    ...(record.input !== undefined ? { input: record.input as Record<string, unknown> } : {}),
  };
}
