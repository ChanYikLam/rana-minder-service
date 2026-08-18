/**
 * 备份/恢复最近事件只读视图（ADR-011 §6.3；observability/README §3）。
 *
 * 路径：src/platform/observability/backup-report/（PR #32 §2.2 B）。
 *
 * 边界：
 * - **只读**：本服务从不触发备份/恢复，从不调用写命令；
 * - **不替代**备份系统：返回的事实来自外部备份/恢复记录端口（首版桩），由
 *   真实备份适配器在 src/adapters/ 解锁后注入（DEP-Q-002 锁定中）；
 * - **不成为**备份完成证明：页面/接口仅展示"最近一次记录"，调用方不得据此
 *   推断"备份已成功完成"——必须以备份系统自身的返回值为准（ADR-011 §3 / §6.3）；
 * - **不写入**业务数据；不查询业务数据；不调用任务执行/重试。
 *
 * 端口契约：
 * - lastBackup() / lastRestore()：返回最近一条记录或 undefined；
 * - recentBackups(limit) / recentRestores(limit)：返回最多 limit 条倒序记录；
 * - 所有方法**不得抛异常**——任何 I/O 失败降级为返回空集（状态页显示"未知"）。
 */

export type BackupStatus = 'success' | 'failure' | 'in-progress';
export type RestoreStatus = 'success' | 'failure' | 'in-progress';

export interface BackupRecord {
  readonly backupId: string;
  readonly startedAt: Date;
  readonly completedAt?: Date;
  readonly status: BackupStatus;
  readonly sizeBytes?: number;
  readonly location?: string;
  readonly error?: string;
}

export interface RestoreRecord {
  readonly restoreId: string;
  readonly startedAt: Date;
  readonly completedAt?: Date;
  readonly status: RestoreStatus;
  readonly triggeredBy?: string;
  readonly error?: string;
}

export interface BackupReportPort {
  lastBackup(): Promise<BackupRecord | undefined>;
  lastRestore(): Promise<RestoreRecord | undefined>;
  recentBackups(limit: number): Promise<readonly BackupRecord[]>;
  recentRestores(limit: number): Promise<readonly RestoreRecord[]>;
}

export class NotWiredBackupReportPort implements BackupReportPort {
  async lastBackup(): Promise<BackupRecord | undefined> {
    return undefined;
  }

  async lastRestore(): Promise<RestoreRecord | undefined> {
    return undefined;
  }

  async recentBackups(_limit: number): Promise<readonly BackupRecord[]> {
    return [];
  }

  async recentRestores(_limit: number): Promise<readonly RestoreRecord[]> {
    return [];
  }
}

export interface BackupReportSnapshot {
  readonly now: Date;
  readonly lastBackup?: BackupRecord;
  readonly lastRestore?: RestoreRecord;
  readonly recentBackups: readonly BackupRecord[];
  readonly recentRestores: readonly RestoreRecord[];
}

export interface BackupReportOptions {
  readonly backupLimit?: number;
  readonly restoreLimit?: number;
}

const DEFAULT_BACKUP_LIMIT = 5;
const DEFAULT_RESTORE_LIMIT = 5;

export interface BackupReportService {
  execute(now: Date, options?: BackupReportOptions): Promise<BackupReportSnapshot>;
}

export class DefaultBackupReportService implements BackupReportService {
  constructor(private readonly port: BackupReportPort) {}

  async execute(now: Date, options: BackupReportOptions = {}): Promise<BackupReportSnapshot> {
    const backupLimit = clampLimit(options.backupLimit ?? DEFAULT_BACKUP_LIMIT);
    const restoreLimit = clampLimit(options.restoreLimit ?? DEFAULT_RESTORE_LIMIT);

    // 并发获取；任一失败已被端口内部降级为空集/未定义，此处不再 try/catch。
    const [lastBackup, lastRestore, recentBackups, recentRestores] = await Promise.all([
      this.port.lastBackup(),
      this.port.lastRestore(),
      this.port.recentBackups(backupLimit),
      this.port.recentRestores(restoreLimit),
    ]);

    return {
      now,
      ...(lastBackup !== undefined ? { lastBackup } : {}),
      ...(lastRestore !== undefined ? { lastRestore } : {}),
      recentBackups,
      recentRestores,
    };
  }
}

function clampLimit(value: number): number {
  if (!Number.isFinite(value) || value < 0) {
    return 0;
  }
  return Math.min(100, Math.floor(value));
}