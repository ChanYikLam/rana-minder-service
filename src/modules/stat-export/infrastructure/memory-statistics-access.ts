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

/**
 * 从环境变量构建可选演示种子（仅 dev/test 下生效，受 ORG_DEV_ACTOR_HEADER 门禁保护）。
 *
 * 用途：默认空种子下，dev/test 中所有用户解析为空作用域，统计端点全部返回 403，
 * 无法本地联调演示。设置 `ORG_DEV_STATS_DEMO=1` 可启用一个明确的演示主体，
 * 使统计端点可达；不设置则保持空种子（fail-closed，生产仍拒绝装配）。
 *
 * 可选环境变量：
 * - ORG_DEV_STATS_DEMO_ACTOR（默认 "stats-demo"）：演示主体 userId；
 * - ORG_DEV_STATS_DEMO_SUPER_ADMIN（可选，逗号分隔）：授予平台超管的主体 userId；
 * - ORG_DEV_STATS_DEMO_CLUBS（可选，逗号分隔）：授予全社团（club 级）作用域的 clubId 列表。
 */
export function buildMemoryStatisticsAuthorizationSeedFromEnv(): MemoryStatisticsAuthorizationSeed {
  const env = process.env;
  if (env['ORG_DEV_STATS_DEMO'] !== '1') return {};

  const actor = env['ORG_DEV_STATS_DEMO_ACTOR'] || 'stats-demo';
  const clubs = (env['ORG_DEV_STATS_DEMO_CLUBS'] ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const superAdmins = (env['ORG_DEV_STATS_DEMO_SUPER_ADMIN'] ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  return {
    superAdminUserIds: superAdmins.length > 0 ? superAdmins : undefined,
    clubScopes:
      clubs.length > 0
        ? {
            [actor]: clubs.map((clubId) => ({
              clubId,
              level: 'club' as const,
              departmentIds: [],
            })),
          }
        : undefined,
  };
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
