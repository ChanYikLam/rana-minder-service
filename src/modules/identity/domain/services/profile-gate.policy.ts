/**
 * IDN-002 资料写入门复合派生策略（SRS-SM-IDN-002；IDN-010/013/019）。
 *
 * 资料门 = 平台必填完备度 + 邮箱验证 + 分范围限制集合，派生优先级：
 *   1. 平台必填缺失          → PENDING_COMPLETION（全系统除补资料外写入关闭）
 *   2. 平台必填完备但邮箱未验证 → PENDING_EMAIL_VERIFICATION
 *   3. 存在未解除的分范围限制 → PARTIALLY_RESTRICTED（作用域键唯一、多限制并集生效、
 *      单独解除，解除一个不误删其他限制）
 *   4. 否则                  → WRITABLE
 *
 * 每次保存/补齐原子重算全部资料门并版本化（IDN-010）；旧版本提交拒绝。
 * 社团/报名级缺失只降级为分范围受限，不构成平台级不可写（IDN-019、FORM-011）。
 *
 * 本策略为纯规则：只接收事实快照与时间，不接触存储/框架；新必填字段规则来源
 * （RequiredFieldRulesPort）在应用层注入。
 */

export interface ScopeRestriction {
  /** 作用域键（社团/报名唯一键） */
  readonly scopeKey: string;
  /** 限制原因（最小可披露） */
  readonly reason: string;
  /** 限制建立时间 */
  readonly since: Date;
}

export interface ProfileGateFacts {
  /** 平台级缺失的必填字段 */
  readonly platformMissingFields: readonly string[];
  /** 邮箱是否已验证 */
  readonly emailVerified: boolean;
  /** 当前生效的分范围限制集合 */
  readonly restrictions: readonly ScopeRestriction[];
}

export type ProfileGateDerivation =
  'PENDING_COMPLETION' | 'PENDING_EMAIL_VERIFICATION' | 'WRITABLE' | 'PARTIALLY_RESTRICTED';

export interface ProfileGatePolicy {
  /** 从事实重算派生门状态（原子重算入口；IDN-010） */
  deriveGate(facts: ProfileGateFacts): ProfileGateDerivation;
  /** 判定给定范围作用域是否被限制（多限制并集；作用域键唯一） */
  isScopeRestricted(restrictions: readonly ScopeRestriction[], scopeKey: string): boolean;
  /** 解除单个限制后其余限制仍生效（并集重算） */
  remainingRestrictions(
    restrictions: readonly ScopeRestriction[],
    scopeKey: string,
  ): readonly ScopeRestriction[];
}

export class DefaultProfileGatePolicy implements ProfileGatePolicy {
  deriveGate(facts: ProfileGateFacts): ProfileGateDerivation {
    if (facts.platformMissingFields.length > 0) {
      return 'PENDING_COMPLETION';
    }
    if (!facts.emailVerified) {
      return 'PENDING_EMAIL_VERIFICATION';
    }
    if (facts.restrictions.length > 0) {
      return 'PARTIALLY_RESTRICTED';
    }
    return 'WRITABLE';
  }

  isScopeRestricted(restrictions: readonly ScopeRestriction[], scopeKey: string): boolean {
    return restrictions.some((r) => r.scopeKey === scopeKey);
  }

  remainingRestrictions(
    restrictions: readonly ScopeRestriction[],
    scopeKey: string,
  ): readonly ScopeRestriction[] {
    return restrictions.filter((r) => r.scopeKey !== scopeKey);
  }
}
