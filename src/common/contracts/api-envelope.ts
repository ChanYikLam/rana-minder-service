/**
 * 传输层请求/响应信封契约
 *
 * 权威来源：
 * - docs/specification/接口实现规格-v1.0.md §2/§3/§4/§8（API-GEN-001~007）
 * - docs/specification/接口清单-HTTP端点-v1.0.md §1.1/§1.2/§1.4
 *
 * 约束：
 * - POST/PUT/DELETE 统一信封解析，业务字段只读 input，不兼容平铺写法。
 * - 文件上传例外：POST /api/files/upload 为 FormData 直传，无信封。
 * - 成功响应 code 恒为 0；任务式响应 code 为 IFC-ERR-013/014。
 */

import type { ApiErrorBody, ApiErrorCode } from './api-error';

/** 成功响应 code 恒为 0（清单 §1.2） */
export type ApiSuccessCode = 0;

export interface ApiSuccess<T = null> {
  code: ApiSuccessCode;
  data: T;
}

/** 任务式响应 data（HTTP 202） */
export interface ApiTaskData {
  taskId: string;
  status: 'processing';
}

export type ApiTaskCode = 'IFC-ERR-013' | 'IFC-ERR-014';

export interface ApiTaskResponse {
  code: ApiTaskCode;
  data: ApiTaskData;
}

/**
 * 失败响应信封（API-GEN-004/005）。
 * 只允许 code/message/supportId/fieldErrors；不得含报名正文、内部评语、
 * 附件内容、完整联系方式、令牌、密钥、数据库结构、内部路径或其他社团对象。
 */
export type ApiErrorResponse = ApiErrorBody;

/** 统一逻辑结果：已完成 / 已受理处理中 / 已拒绝（含依赖不可用等） */
export type ApiResponse<T = null> = ApiSuccess<T> | ApiErrorResponse | ApiTaskResponse;

/**
 * 统一请求信封（API-GEN-003）。
 * 顶层仅允许 action/targetId/expectedVersion/idempotencyKey/input 五键；
 * 业务字段一律位于 input 内。
 */
export interface ApiRequestEnvelope<TInput = unknown> {
  /** 可选，业务动作标识；动作必须对应登记过的逻辑操作 */
  action?: string;
  /** 可选，目标对象稳定标识；调用方只提供候选标识，服务端回源验证 */
  targetId?: string;
  /** 可选，乐观锁期望版本；不匹配 → 409 IFC-ERR-008 */
  expectedVersion?: number;
  /** 可选，业务幂等键；同键同摘要返回原结果，同键异参 → 409 IFC-ERR-009 */
  idempotencyKey?: string;
  /** 业务字段容器 */
  input?: TInput;
}

/** 列表响应（API-GEN-008）：items + 游标分页 */
export interface ApiListResponse<T> {
  items: T[];
  nextCursor: string | null;
}

/** 无内容类删除等可返回 204（data 为空） */
export type ApiNoContent = ApiSuccess<null>;

/** 版本冲突响应体（可携带当前数据） */
export interface ApiConflictCurrentData {
  currentData?: unknown;
}

export type { ApiErrorCode };
