/**
 * 内存导出授权/审计/安全开关/重新认证桩（开发与单测用，5.4.2）。
 *
 * 门禁口径与 MemoryStatisticsAuthorizationPort 一致：
 * - 仅 NODE_ENV=development|test 且 ORG_DEV_ACTOR_HEADER=1 时允许装配；
 * - 生产环境直接拒绝装配（fail-closed，GOV-007 防护）。
 *
 * 授权桩按 userId 派生 5 类导出者（ExportExporterKind）与其社团作用域；
 * 审计桩仅内存记录；重新认证桩记录最近一次高风险重认证时间。
 */

import type {
  ExportAuditEntry,
  ExportAuditPort,
  ExportAuthorizationPort,
  ExportClubScope,
  ExportExporterKind,
  ExportPrincipal,
  ExportReauthPort,
  ExportSafetySwitchPort,
  ExportSafetySwitchState,
} from '../application/ports/export-authorization.port';

// ---------------------------------------------------------------------------
// 授权桩种子
// ---------------------------------------------------------------------------

export interface MemoryExportAuthorizationSeed {
  /** 平台超管 userId 集合（kind 强制为 platform_super_admin） */
  readonly superAdminUserIds?: readonly string[];
  /** 按 userId 覆盖导出者分类；未登记默认为 member_applicant */
  readonly kinds?: Readonly<Record<string, ExportExporterKind>>;
  /** 按 userId → 社团作用域清单；未登记视为空作用域 */
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

export class MemoryExportAuthorizationPort implements ExportAuthorizationPort {
  private readonly superAdminSet: ReadonlySet<string>;
  private readonly kinds: ReadonlyMap<string, ExportExporterKind>;
  private readonly scopes: ReadonlyMap<string, readonly ExportClubScope[]>;

  constructor(private readonly seed: MemoryExportAuthorizationSeed) {
    const env = process.env;
    if (env['NODE_ENV'] === 'production') {
      throw new Error('MemoryExportAuthorizationPort 为开发桩，违反 GOV-007，禁止用于生产装配');
    }
    if (env['ORG_DEV_ACTOR_HEADER'] !== '1') {
      throw new Error(
        'MemoryExportAuthorizationPort 为开发桩，须显式设置 ORG_DEV_ACTOR_HEADER=1 方可装配',
      );
    }

    this.superAdminSet = new Set(seed.superAdminUserIds ?? []);
    this.kinds = new Map(Object.entries(seed.kinds ?? {}));
    const map = new Map<string, readonly ExportClubScope[]>();
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

  async resolveExportPrincipal(userId: string): Promise<ExportPrincipal> {
    const kind: ExportExporterKind = this.superAdminSet.has(userId)
      ? 'platform_super_admin'
      : (this.kinds.get(userId) ?? 'member_applicant');
    return {
      userId,
      kind,
      clubScopes: this.scopes.get(userId) ?? [],
    };
  }
}

// ---------------------------------------------------------------------------
// 安全开关桩（GOV-004）
// ---------------------------------------------------------------------------

export class MemoryExportSafetySwitchPort implements ExportSafetySwitchPort {
  private allowed = true;
  private reason: string | undefined;

  setAllowed(allowed: boolean, reason?: string): void {
    this.allowed = allowed;
    this.reason = reason;
  }

  async checkAllowed(): Promise<ExportSafetySwitchState> {
    return { allowed: this.allowed, reason: this.reason };
  }
}

// ---------------------------------------------------------------------------
// 重新认证桩（IFC-ERR-002）
// ---------------------------------------------------------------------------

export class MemoryExportReauthPort implements ExportReauthPort {
  private latestByUser = new Map<string, Date>();

  /** 测试辅助：记录一次高风险重认证 */
  recordReauth(userId: string, at?: Date): void {
    this.latestByUser.set(userId, at ?? new Date());
  }

  async latestReauthAt(userId: string): Promise<Date | null> {
    return this.latestByUser.get(userId) ?? null;
  }
}

// ---------------------------------------------------------------------------
// 审计桩实现
// ---------------------------------------------------------------------------

export class InMemoryExportAuditPort implements ExportAuditPort {
  readonly entries: ExportAuditEntry[] = [];

  async record(entry: ExportAuditEntry): Promise<void> {
    this.entries.push({ ...entry });
  }

  /** 测试辅助：清空审计日志 */
  clear(): void {
    this.entries.length = 0;
  }

  /** 测试辅助：按条件查询 */
  findBy(action: ExportAuditEntry['action']): ExportAuditEntry[] {
    return this.entries.filter((e) => e.action === action);
  }
}
