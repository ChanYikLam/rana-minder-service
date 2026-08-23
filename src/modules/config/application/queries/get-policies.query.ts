/**
 * 作用域策略查询（CFG-002，5.5.2）：解析后的生效值+作用域+生效时间
 * （CFG-002「所有配置显示作用域和生效时间」）。
 */

import {
  POLICY_KEYS,
  POLICY_REGISTRY,
  ScopedPolicyTable,
  type PolicyKey,
  type ScopedPolicyTableSnapshot,
} from '../../domain/models/scoped-policy';
import type { ScopedPolicyTableRepositoryPort } from '../ports';

export interface ResolvedPolicyView {
  readonly key: PolicyKey;
  readonly unit: string;
  /** 生效值：社团覆盖优先，否则平台默认 */
  readonly resolvedValue: number;
  /** 生效来源作用域 */
  readonly scope: 'PLATFORM' | 'CLUB';
  /** 来源条目的最近生效时间 */
  readonly effectiveAt: Date | null;
  readonly allowedMin: number;
  readonly allowedMax: number;
  readonly affectsStudentRights: boolean;
}

function loadOrCreate(snapshot: ScopedPolicyTableSnapshot | null): ScopedPolicyTable {
  return snapshot === null
    ? ScopedPolicyTable.createDefault()
    : ScopedPolicyTable.fromSnapshot(snapshot);
}

export class GetResolvedPoliciesQuery {
  constructor(private readonly repository: ScopedPolicyTableRepositoryPort) {}

  async execute(input: { clubId: string }): Promise<readonly ResolvedPolicyView[]> {
    const raw = await this.repository.load();
    const table = loadOrCreate(raw);

    return POLICY_KEYS.map((key) => {
      const platformEntry = table.listPlatformEntries().find((e) => e.key === key)!;
      const clubEntry = table.listClubEntries(input.clubId).find((e) => e.key === key);
      const def = POLICY_REGISTRY[key];
      if (clubEntry) {
        return {
          key,
          unit: def.unit,
          resolvedValue: clubEntry.value,
          scope: 'CLUB' as const,
          effectiveAt: clubEntry.updatedAt,
          allowedMin: platformEntry.allowedMin,
          allowedMax: platformEntry.allowedMax,
          affectsStudentRights: def.affectsStudentRights,
        };
      }
      return {
        key,
        unit: def.unit,
        resolvedValue: platformEntry.defaultValue,
        scope: 'PLATFORM' as const,
        effectiveAt: platformEntry.updatedAt,
        allowedMin: platformEntry.allowedMin,
        allowedMax: platformEntry.allowedMax,
        affectsStudentRights: def.affectsStudentRights,
      };
    });
  }
}

/** 平台层条目视图（超管后台维护界面用；含允许范围与最近修改人/时间） */
export class GetPlatformPoliciesQuery {
  constructor(private readonly repository: ScopedPolicyTableRepositoryPort) {}

  async execute() {
    const raw = await this.repository.load();
    const table = loadOrCreate(raw);
    return {
      entries: table.listPlatformEntries(),
      changes: table.changes,
    };
  }
}
