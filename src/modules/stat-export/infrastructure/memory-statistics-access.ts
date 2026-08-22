/**
 * 内存统计授权/审计桩（开发/单测用）。
 *
 * 授权桩门禁（与 MemoryCurrentPermissionsPort 口径一致）：
 * - 仅 NODE_ENV=development|test 且 ORG_DEV_ACTOR_HEADER=1 时允许装配；
 * - 生产环境直接拒绝装配（fail-closed，GOV-007 防护）。
 *
 * 审计桩仅内存记录，供断言审计追踪。
 */

import type {
  StatisticsPrincipal,
  StatisticsClubScope,
  StatisticsAccessAuditEntry,
  StatisticsAuthorizationPort,
  StatisticsAuditPort,
} from '../application/ports/statistics-authorization.port';

// ---------------------------------------------------------------------------
// 授权桩种子
// ---------------------------------------------------------------------------

export interface MemoryStatisticsAuthorizationSeed {
  readonly superAdminUserIds?: readonly string[];
  /** 按 userId → 作用域清单；未登记的用户视为普通成员/申请人（空作用域） */
  readonly clubScopes?: Readonly<
    Record<
      string,
      ReadonlyArray<{
        clubId: string;
        level: 'club' | 'department';
        departmentIds?: readonly string[];
      }>
    >
  >;
}

// ---------------------------------------------------------------------------
// 授权桩实现
// ---------------------------------------------------------------------------

export class MemoryStatisticsAuthorizationPort implements StatisticsAuthorizationPort {
  private readonly superAdminSet: ReadonlySet<string>;
  private readonly scopes: ReadonlyMap<string, readonly StatisticsClubScope[]>;

  constructor(private readonly seed: MemoryStatisticsAuthorizationSeed) {
    // 开发门禁（GOV-007 防护：此桩按配置直接派生角色，不可用于生产）
    const env = process.env;
    if (env['NODE_ENV'] === 'production') {
      throw new Error(
        'MemoryStatisticsAuthorizationPort 为 Group 名派生的开发桩，违反 GOV-007，禁止用于生产装配',
      );
    }
    if (env['ORG_DEV_ACTOR_HEADER'] !== '1') {
      throw new Error(
        'MemoryStatisticsAuthorizationPort 为开发桩，须显式设置 ORG_DEV_ACTOR_HEADER=1 方可装配',
      );
    }

    this.superAdminSet = new Set(seed.superAdminUserIds ?? []);
    const map = new Map<string, readonly StatisticsClubScope[]>();
    if (seed.clubScopes) {
      for (const [userId, scopes] of Object.entries(seed.clubScopes)) {
        map.set(
          userId,
          scopes.map((s) => ({
            clubId: s.clubId,
            level: s.level,
            departmentIds: s.departmentIds ? [...s.departmentIds] : [],
          })),
        );
      }
    }
    this.scopes = map;
  }

  async resolvePrincipal(userId: string): Promise<StatisticsPrincipal> {
    const scopes = this.scopes.get(userId) ?? [];
    return {
      userId,
      isPlatformSuperAdmin: this.superAdminSet.has(userId),
      clubScopes: scopes,
    };
  }
}

// ---------------------------------------------------------------------------
// 审计桩实现
// ---------------------------------------------------------------------------

export class InMemoryStatisticsAuditPort implements StatisticsAuditPort {
  readonly entries: StatisticsAccessAuditEntry[] = [];

  async record(entry: StatisticsAccessAuditEntry): Promise<void> {
    this.entries.push({ ...entry, at: entry.at ?? new Date().toISOString() });
  }

  /** 测试辅助：清空审计日志 */
  clear(): void {
    this.entries.length = 0;
  }

  /** 测试辅助：按条件查询 */
  findBy(action: string): StatisticsAccessAuditEntry[] {
    return this.entries.filter((e) => e.action === action);
  }
}
