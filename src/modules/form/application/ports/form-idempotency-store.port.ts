/**
 * 表单设计命令幂等存储端口（IFC-GEN-006；SRS-SM-FORM-001 t1 创建幂等）。
 *
 * 幂等作用域 ≥ 逻辑命令类型＋真实作用域＋业务幂等键；同键同语义摘要返回原结果，
 * 同键异摘要稳定拒绝（409 IFC-ERR-009）。服务端按版本化规范化规则计算摘要，
 * 客户端不得自报身份、权限或作用域（IFC-GEN-001）。
 *
 * 两阶段协议：claim 先占位（并返回是否新占位 / 既有摘要），业务成功后 complete
 * 回填结果；重放方在 claim 命中既有记录后 readResult 取得原结果（结果尚未回填时
 * 返回 IFC-ERR-014 结果处理中，稍后重试）。
 */

export interface FormIdempotencyClaim {
  readonly scopeKey: string;
  readonly idempotencyKey: string;
  readonly semanticHash: string;
}

export interface FormIdempotencyCompletion {
  readonly scopeKey: string;
  readonly idempotencyKey: string;
  readonly semanticHash: string;
  readonly result: unknown;
}

export interface FormIdempotencyClaimOutcome {
  /** 本次是否新占位（true=继续执行；false=既有记录，应读结果重放） */
  readonly inserted: boolean;
  /** 既有记录摘要（inserted=false 时用于同摘要/异摘要判定） */
  readonly existingHash: string | null;
}

export interface FormIdempotencyStore {
  claim(input: FormIdempotencyClaim): Promise<FormIdempotencyClaimOutcome>;
  complete(input: FormIdempotencyCompletion): Promise<void>;
  readResult(scopeKey: string, idempotencyKey: string): Promise<unknown | null>;
  /** 释放一次失败的占位（删除 claim 记录），使同幂等键可重试 */
  release(scopeKey: string, idempotencyKey: string): Promise<void>;
}
