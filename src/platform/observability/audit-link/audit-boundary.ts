/**
 * 业务审计与运行日志分离边界（ADR-011 §2.1 第 4 条；XCC-GEN-007）。
 *
 * 路径：src/platform/observability/audit-link/（PR #32 §2.2 B）。
 *
 * 落地：
 * - 运行日志写入器接收到字段时，调用本守卫；
 * - 守卫拒绝把审计敏感字段写入运行日志层（业务审计模块独立长期保留）；
 * - 本守卫**不替代**也不**连接**审计模块（XCC-GEN-007）；审计的写、读、
 *   留存、归档均由 audit 模块独立完成。
 *
 * 与 RedactionRules 的差别：
 * - RedactionRules 处理"值怎么脱敏"（mask / truncate / path / omit）；
 * - 本守卫处理"字段是否允许进入运行日志层"——命中即抛错，**整条记录拒绝
 *   写入**而非脱敏改写（语义不同：脱敏允许保留有限线索用于排错，边界
 *   拒绝承认这是运行日志该有的字段）。
 *
 * 禁止写为运行日志的字段前缀：
 *  - `audit.*`（审计原始负载、审计 ID）
 *  - `permission.*`、`role.*`、`authorization.*`（权限来源、角色判定结果）
 *  - `decision.*`（业务决策结果）
 *
 * 边界收紧由调用方在 extraForbiddenPrefixes 中按需追加；本守卫默认仅覆盖
 * 上述四类前缀，不做超集。
 */

const DEFAULT_FORBIDDEN_PREFIXES: readonly RegExp[] = [
  /^audit\./i,
  /^permission\./i,
  /^role\./i,
  /^authorization\./i,
  /^decision\./i,
];

export class AuditBoundaryViolation extends Error {
  constructor(public readonly field: string) {
    super(
      `Audit boundary violation: field '${field}' must not enter run-log layer (ADR-011 §2.1 / XCC-GEN-007)`,
    );
    this.name = 'AuditBoundaryViolation';
  }
}

export interface AuditBoundaryAssert {
  assert(field: string): void;
  isForbidden(field: string): boolean;
}

export interface AuditBoundaryAssertOptions {
  readonly extraForbiddenPrefixes?: readonly RegExp[];
}

export class DefaultAuditBoundaryAssert implements AuditBoundaryAssert {
  private readonly patterns: readonly RegExp[];

  constructor(options: AuditBoundaryAssertOptions = {}) {
    this.patterns = [...DEFAULT_FORBIDDEN_PREFIXES, ...(options.extraForbiddenPrefixes ?? [])];
  }

  assert(field: string): void {
    if (this.isForbidden(field)) {
      throw new AuditBoundaryViolation(field);
    }
  }

  isForbidden(field: string): boolean {
    return this.patterns.some((p) => p.test(field));
  }
}
