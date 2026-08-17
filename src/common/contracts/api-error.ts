/**
 * 传输层错误码契约（17 类）
 *
 * 权威来源：
 * - docs/specification/接口实现规格-v1.0.md §7（API-ERR-001/002）
 * - docs/specification/接口契约-v1.0.md §8（IFC-ERR-001~016）
 * - docs/specification/接口清单-HTTP端点-v1.0.md §1.3（IFC-ERR-017 为清单新增）
 *
 * 约束：
 * - 错误码只增不改；本地化文案由前端按 code 渲染。
 * - 错误响应只允许出现 code/message/supportId/fieldErrors 四类信息。
 * - 该文件只承载“目录 + HTTP 状态映射”，不承载任何领域规则。
 */

export const IFC_ERROR_CODES = [
  'IFC-ERR-001',
  'IFC-ERR-002',
  'IFC-ERR-003',
  'IFC-ERR-004',
  'IFC-ERR-005',
  'IFC-ERR-006',
  'IFC-ERR-007',
  'IFC-ERR-008',
  'IFC-ERR-009',
  'IFC-ERR-010',
  'IFC-ERR-011',
  'IFC-ERR-012',
  'IFC-ERR-013',
  'IFC-ERR-014',
  'IFC-ERR-015',
  'IFC-ERR-016',
  'IFC-ERR-017',
] as const;

export type ApiErrorCode = (typeof IFC_ERROR_CODES)[number];

/**
 * 与错误码对应的 HTTP 状态码映射（API-ERR-001 全表）。
 * IFC-ERR-013/014 用于任务式响应，HTTP 202；IFC-ERR-017 为请求体解析失败。
 */
export const IFC_ERROR_HTTP_STATUS: Record<ApiErrorCode, number> = {
  'IFC-ERR-001': 401,
  'IFC-ERR-002': 401,
  'IFC-ERR-003': 403,
  'IFC-ERR-004': 403,
  'IFC-ERR-005': 422,
  'IFC-ERR-006': 422,
  'IFC-ERR-007': 409,
  'IFC-ERR-008': 409,
  'IFC-ERR-009': 409,
  'IFC-ERR-010': 409,
  'IFC-ERR-011': 403,
  'IFC-ERR-012': 503,
  'IFC-ERR-013': 202,
  'IFC-ERR-014': 202,
  'IFC-ERR-015': 404,
  'IFC-ERR-016': 500,
  'IFC-ERR-017': 400,
};

export interface ApiFieldErrors {
  [field: string]: string[];
}

export interface ApiErrorBody {
  /** 稳定错误分类，值必须来自 IFC_ERROR_CODES */
  code: ApiErrorCode;
  /** 安全可披露的最小原因；本地化由前端按 code 渲染 */
  message: string;
  /** 安全追踪编号；与幂等键严格分离，不得互相替代 */
  supportId: string;
  /** 字段级错误；仅结构校验（IFC-ERR-005）等允许携带 */
  fieldErrors?: ApiFieldErrors;
}

/** 版本冲突响应可携带当前数据供刷新（API-GEN-007） */
export interface ApiVersionConflictBody<T = unknown> extends ApiErrorBody {
  code: 'IFC-ERR-008';
  currentData?: T;
}
