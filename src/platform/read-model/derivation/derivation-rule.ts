import type { AuthoritativeSnapshot } from '../contracts';

/**
 * 派生规则（从权威对象派生投影；纯函数，不依赖框架/存储）。
 *
 * 明确不做个性化推荐（read-model README §2）：派生是确定性的、
 * 可重建的投影，不引入用户偏好、排序分数或不可复现逻辑。
 * 派生失败不改源业务（IFC-TX-008）。
 */
export interface DerivationRule<TSource extends AuthoritativeSnapshot, TProjection> {
  /** 规则名称（登记/可观测用） */
  readonly ruleName: string;
  /** 从权威对象快照派生投影数据（确定性、无副作用） */
  derive(source: TSource): TProjection;
}
