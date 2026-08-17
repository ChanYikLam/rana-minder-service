/**
 * 派生规则（derivation/）：从权威对象派生投影的纯规则。
 *
 * - derivation-rule.ts       派生规则接口（确定性、可重建、不做个性化推荐）
 * - search-normalizer.ts     搜索文本规范化（NFC→折叠→NFC→去空白→压缩）
 * - visibility-derivation.ts 可见性派生（发布状态/访问者类型/字段投影）
 */
export * from './derivation-rule';
export * from './search-normalizer';
export * from './visibility-derivation';
