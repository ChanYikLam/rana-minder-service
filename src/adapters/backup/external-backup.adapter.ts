/**
 * 备份报告外部服务适配器（adapters/backup/external-backup.adapter.ts；T3）。
 *
 * 权威依据：observability/backup-report（BackupReportPort 契约）、ADR-011 §3/§6.3。
 *
 * 职责：
 * - 从外部备份/恢复记录服务查询最近事件，返回规范化 BackupRecord / RestoreRecord；
 * - 只读：本适配从不触发备份/恢复；
 * - 任何 I/O 失败降级为返回空集（状态页显示"未知"），绝不抛异常、绝不伪造成功。
 *
 * 依赖可用性由 `ADAPTERS_BACKUP_REAL=1` 开关控制（fail-closed，默认关闭）。
 */

import type {
  BackupRecord,
  BackupReportPort,
  RestoreRecord,
} from '../../platform/observability/backup-report/backup-report';
import { toRedactedErrorSummary } from '../redaction';

export interface ExternalBackupAdapterOptions {
  readonly endpoint: string;
  readonly token?: string;
  readonly fetchFn?: typeof fetch;
  readonly timeoutMs?: number;
}

interface RawRecord {
  readonly id?: unknown;
  readonly backupId?: unknown;
  readonly restoreId?: unknown;
  readonly startedAt?: unknown;
  readonly completedAt?: unknown;
  readonly status?: unknown;
  readonly sizeBytes?: unknown;
  readonly location?: unknown;
  readonly error?: unknown;
  readonly triggeredBy?: unknown;
}

function toBackupRecord(raw: RawRecord): BackupRecord | null {
  if (typeof raw?.backupId !== 'string' || typeof raw?.startedAt !== 'string') {
    return null;
  }
  if (raw.status !== 'success' && raw.status !== 'failure' && raw.status !== 'in-progress') {
    // ADR-011 §6.3：遇到无法识别的中间态/未知态时跳过该记录，状态页显示"未知"，
    // 不把"不确定"伪装成确定的 failure（只展示事实、不伪造健康）。
    return null;
  }
  const completed = typeof raw.completedAt === 'string' ? new Date(raw.completedAt) : undefined;
  const status = raw.status;
  return {
    backupId: raw.backupId,
    startedAt: new Date(raw.startedAt),
    ...(completed ? { completedAt: completed } : {}),
    status,
    ...(typeof raw.sizeBytes === 'number' ? { sizeBytes: raw.sizeBytes } : {}),
    ...(typeof raw.location === 'string' ? { location: raw.location } : {}),
    ...(typeof raw.error === 'string' ? { error: toRedactedErrorSummary(raw.error) } : {}),
  };
}

function toRestoreRecord(raw: RawRecord): RestoreRecord | null {
  if (typeof raw?.restoreId !== 'string' || typeof raw?.startedAt !== 'string') {
    return null;
  }
  if (raw.status !== 'success' && raw.status !== 'failure' && raw.status !== 'in-progress') {
    // ADR-011 §6.3：同 toBackupRecord，未知态跳过，不伪造为确定的 failure。
    return null;
  }
  const completed = typeof raw.completedAt === 'string' ? new Date(raw.completedAt) : undefined;
  const status = raw.status;
  return {
    restoreId: raw.restoreId,
    startedAt: new Date(raw.startedAt),
    ...(completed ? { completedAt: completed } : {}),
    status,
    ...(typeof raw.triggeredBy === 'string' ? { triggeredBy: raw.triggeredBy } : {}),
    ...(typeof raw.error === 'string' ? { error: toRedactedErrorSummary(raw.error) } : {}),
  };
}

export class ExternalBackupAdapter implements BackupReportPort {
  private readonly endpoint: string;
  private readonly token?: string;
  private readonly fetchFn: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: ExternalBackupAdapterOptions) {
    this.endpoint = options.endpoint.replace(/\/+$/, '');
    this.token = options.token;
    this.fetchFn = options.fetchFn ?? globalThis.fetch.bind(globalThis);
    this.timeoutMs = options.timeoutMs ?? 10_000;
  }

  private async getList<T>(path: string, map: (raw: RawRecord) => T | null): Promise<readonly T[]> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchFn(`${this.endpoint}${path}`, {
        method: 'GET',
        signal: controller.signal,
        headers: { ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}) },
      });
      if (!res.ok) {
        return [];
      }
      const parsed = (await res.json()) as { records?: RawRecord[] };
      if (!Array.isArray(parsed?.records)) {
        return [];
      }
      return parsed.records.map(map).filter((r): r is T => r !== null);
    } catch {
      return [];
    } finally {
      clearTimeout(timer);
    }
  }

  async lastBackup(): Promise<BackupRecord | undefined> {
    const list = await this.getList<BackupRecord>('/api/backup/latest', (raw) =>
      toBackupRecord(raw),
    );
    return list[0];
  }

  async lastRestore(): Promise<RestoreRecord | undefined> {
    const list = await this.getList<RestoreRecord>('/api/restore/latest', (raw) =>
      toRestoreRecord(raw),
    );
    return list[0];
  }

  async recentBackups(limit: number): Promise<readonly BackupRecord[]> {
    const list = await this.getList<BackupRecord>(
      `/api/backup?limit=${encodeURIComponent(String(limit))}`,
      (raw) => toBackupRecord(raw),
    );
    return list.slice(0, limit);
  }

  async recentRestores(limit: number): Promise<readonly RestoreRecord[]> {
    const list = await this.getList<RestoreRecord>(
      `/api/restore?limit=${encodeURIComponent(String(limit))}`,
      (raw) => toRestoreRecord(raw),
    );
    return list.slice(0, limit);
  }
}
