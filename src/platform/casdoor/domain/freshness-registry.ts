/**
 * 登记式分层新鲜度（CAS-Q-002 方案 A、CAS-REC-011）。
 *
 * 每个受保护逻辑操作必须在受控目录中声明新鲜度等级；未知操作按实时读回
 * 失败关闭，不允许调用方/页面/SDK 自选。
 */

export const FreshnessLevel = {
  REAL_TIME: 'REAL_TIME',
  OBSERVATION: 'OBSERVATION',
} as const;

export type FreshnessLevel = (typeof FreshnessLevel)[keyof typeof FreshnessLevel];

export interface FreshnessRule {
  readonly operation: string;
  readonly level: FreshnessLevel;
  /** 仅 OBSERVATION 使用：超过该时效必须先定向刷新。 */
  readonly maxObservationAgeMs?: number;
}

export const OPERATION_LOGIN_SESSION = 'LOGIN_SESSION';
export const OPERATION_ENHANCED_AUTH = 'ENHANCED_AUTH';
export const OPERATION_HIGH_RISK_COMMAND = 'HIGH_RISK_COMMAND';
export const OPERATION_PERMISSION_SENSITIVE_READ = 'PERMISSION_SENSITIVE_READ';
export const OPERATION_WRITE_READBACK = 'WRITE_READBACK';
export const OPERATION_NORMAL_PROTECTED_READ = 'NORMAL_PROTECTED_READ';

export class FreshnessRegistry {
  private readonly rules = new Map<string, FreshnessRule>();

  constructor() {
    this.register({ operation: OPERATION_LOGIN_SESSION, level: FreshnessLevel.REAL_TIME });
    this.register({ operation: OPERATION_ENHANCED_AUTH, level: FreshnessLevel.REAL_TIME });
    this.register({ operation: OPERATION_HIGH_RISK_COMMAND, level: FreshnessLevel.REAL_TIME });
    this.register({
      operation: OPERATION_PERMISSION_SENSITIVE_READ,
      level: FreshnessLevel.REAL_TIME,
    });
    this.register({ operation: OPERATION_WRITE_READBACK, level: FreshnessLevel.REAL_TIME });
    this.register({
      operation: OPERATION_NORMAL_PROTECTED_READ,
      level: FreshnessLevel.OBSERVATION,
      maxObservationAgeMs: 60_000,
    });
  }

  register(rule: FreshnessRule): void {
    if (this.rules.has(rule.operation)) {
      throw new Error(`Freshness rule already registered: ${rule.operation}`);
    }
    this.rules.set(rule.operation, rule);
  }

  resolve(operation: string): FreshnessRule | null {
    return this.rules.get(operation) ?? null;
  }

  requireRealTime(operation: string): boolean {
    const rule = this.rules.get(operation);
    if (rule === undefined) return true; // 未知操作失败关闭
    return rule.level === FreshnessLevel.REAL_TIME;
  }
}
