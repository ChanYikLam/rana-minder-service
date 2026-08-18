/**
 * observability/health-summary 子模块的 DI 标识符。
 *
 * 字符串标识符约定同 src/config/tokens.ts。
 *
 * 本子模块是**对内**健康汇总服务（被其它模块消费），**不是**机器健康端点
 * （ADR-011 §6.3 / observability/README §6.3 明确禁止）；不对外暴露 HTTP。
 */

export const HEALTH_SUMMARY_SERVICE = 'OBSERVABILITY_HEALTH_SUMMARY_SERVICE';