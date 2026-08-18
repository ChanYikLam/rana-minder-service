/**
 * 平台支撑 · 运维与可观测性模块入口（ADR-002 §2.2 + ADR-011 + PR #32 §2.2 B）。
 *
 * 当前阶段仅注册已落地的纯领域规则（脱敏 / 保留期 / 追踪编号），供
 * infrastructure/LogWriterAdapter、TraceContextAdapter 等后续组件消费。
 *
 * 边界（ADR-011 §2.1 核心不变量；本模块第一阶段即锁定，约束后续所有子模块）：
 *
 * 1. 状态页读取技术运行事实或可重建摘要，**不成为**业务状态、权限、通知事实、
 *    任务执行权威或备份完成证明。
 * 2. 状态来源过期时必须显示"未知"，不得以最近一次成功伪装当前健康。
 * 3. 观测信息不得自动改变录取、邀请、成员、部门、职位、评价、权限或其他业务
 *    结论。
 * 4. 业务审计独立长期保留，运行日志不得替代业务审计；业务幂等键与追踪编号
 *    不得混同（XCC-GEN-001）。
 *
 * 子模块接入顺序（不在本 MR 范围，按 PR #32 §2.2 B 子任务次序）：
 *   logging/ → tracing/ → audit-link/ → status-page/ → health-summary/
 *   → backup-report/ → 基础设施 & 应用层组装 → 测试。
 *
 * 依赖注入：使用 useValue 把纯函数模块冻结为 provider 对象；规则保持
 * `Object.freeze` 不可变，便于在测试中辨别误改。
 */

import { Module, type Provider } from '@nestjs/common';

import {
  REDACTION_RULES,
  RETENTION_RULES,
  TRACE_ID_GENERATOR,
} from './domain/services/tokens';
import {
  FORBIDDEN_KEY_PATTERNS,
  SENSITIVE_KEY_PATTERNS,
  PATH_KEY_PATTERNS,
  SAFE_KEY_PATTERNS,
  DEFAULT_TRUNCATE_MAX,
  decide,
  redactValue,
  redactRecord,
} from './domain/services/redaction.rules';
import {
  DEFAULT_RETENTION_POLICIES,
  resolveRetention,
  isLogTier,
} from './domain/services/retention.rules';
import {
  TRACE_PREFIX,
  generateTraceId,
  isTraceId,
  deriveTrace,
} from './domain/services/trace-id.generator';

const REDACTION_RULES_PROVIDER: Provider = {
  provide: REDACTION_RULES,
  useValue: Object.freeze({
    FORBIDDEN_KEY_PATTERNS,
    SENSITIVE_KEY_PATTERNS,
    PATH_KEY_PATTERNS,
    SAFE_KEY_PATTERNS,
    DEFAULT_TRUNCATE_MAX,
    decide,
    redactValue,
    redactRecord,
  }),
};

const RETENTION_RULES_PROVIDER: Provider = {
  provide: RETENTION_RULES,
  useValue: Object.freeze({
    DEFAULT_RETENTION_POLICIES,
    resolveRetention,
    isLogTier,
  }),
};

const TRACE_ID_PROVIDER: Provider = {
  provide: TRACE_ID_GENERATOR,
  useValue: Object.freeze({
    TRACE_PREFIX,
    generateTraceId,
    isTraceId,
    deriveTrace,
  }),
};

@Module({
  imports: [],
  providers: [REDACTION_RULES_PROVIDER, RETENTION_RULES_PROVIDER, TRACE_ID_PROVIDER],
  exports: [REDACTION_RULES, RETENTION_RULES, TRACE_ID_GENERATOR],
})
export class ObservabilityModule {}