import type { ProjectionScope, VisitorType } from '../contracts';

/**
 * 查询授权上下文（服务端授权后投影）。
 *
 * 授权判定由组织与授权模块完成；read-model 只承接判定结果
 * （read-model README §6.3：每次受保护请求都执行当前服务端授权，
 * 缓存命中不得跳过用户、对象、操作、作用域和状态检查）。
 */
export interface QueryAuthContext {
  /** 主体稳定标识（未认证=null，仅公开目录允许） */
  readonly principalId: string | null;
  /** 访问者类型（字段投影依据） */
  readonly visitor: VisitorType;
  /** 服务端判定已授权的目标作用域（越界请求一律拒绝） */
  readonly grantedScopes: readonly ProjectionScope[];
}
