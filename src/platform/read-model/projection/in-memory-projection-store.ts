import { Injectable } from '@nestjs/common';
import type { ProjectionRecord, ProjectionScope, ProjectionType } from '../contracts';
import { ProjectionRecordStatus } from '../contracts';
import type { ProjectionStore, SaveOptions } from './projection-store';

/** 存储条目：记录 + 可选过期时间戳（ms epoch） */
interface StoredEntry {
  readonly record: ProjectionRecord;
  /** 过期时间（Date.now() 毫秒）；undefined=不过期 */
  readonly expiresAt?: number;
}

/**
 * 进程内投影存储（可重建缓存载体占位，ADR-007）。
 *
 * 语义：全部丢失/过期/清空时必须能从权威来源重建出相同结果；
 * 只保存可重建派生数据，不承载授权（IFC-DATA-012）。
 * 单实例/开发期占位：多实例共享或持久化需求出现时替换为
 * PostgreSQL 投影实现（基础设施任务）。
 *
 * 覆盖 C2.1：冷缓存（load=null）、清空（clear）、过期（save ttlMs）、
 * 重建回源（save 覆盖同水位旧值）。
 */
@Injectable()
export class InMemoryProjectionStore implements ProjectionStore {
  private readonly entries = new Map<string, StoredEntry>();

  async save<TData>(record: ProjectionRecord<TData>, options?: SaveOptions): Promise<void> {
    const expiresAt = options?.ttlMs !== undefined ? Date.now() + options.ttlMs : undefined;
    this.entries.set(this.key(record.projectionType, record.watermark.scope), {
      record,
      expiresAt,
    });
  }

  async load<TData>(
    projectionType: ProjectionType,
    scope: ProjectionScope,
  ): Promise<ProjectionRecord<TData> | null> {
    const key = this.key(projectionType, scope);
    const entry = this.entries.get(key);
    if (entry === undefined) {
      return null;
    }
    // 过期：不再作为新鲜结果返回，并顺手清理（C2.1 过期语义）
    if (entry.expiresAt !== undefined && Date.now() >= entry.expiresAt) {
      this.entries.delete(key);
      return null;
    }
    if (entry.record.status !== ProjectionRecordStatus.ACTIVE) {
      return null;
    }
    return entry.record as ProjectionRecord<TData>;
  }

  async invalidate(
    projectionType: ProjectionType,
    scope: ProjectionScope,
    invalidatedAt: string,
    rebuildBasis: string,
  ): Promise<void> {
    const key = this.key(projectionType, scope);
    const existing = this.entries.get(key);
    if (existing === undefined) {
      return;
    }
    this.entries.set(key, {
      record: {
        ...existing.record,
        status: ProjectionRecordStatus.INVALIDATED,
        invalidatedAt,
        rebuildBasis,
      },
      expiresAt: existing.expiresAt,
    });
  }

  async findByScope<TData>(
    projectionType: ProjectionType,
    scope: ProjectionScope,
  ): Promise<readonly ProjectionRecord<TData>[]> {
    const prefix = `${projectionType}|`;
    const scopeJson = JSON.stringify(scope);
    const result: ProjectionRecord<TData>[] = [];
    for (const [key, entry] of this.entries) {
      if (key.startsWith(prefix) && key.includes(scopeJson)) {
        result.push(entry.record as ProjectionRecord<TData>);
      }
    }
    return result;
  }

  async clear(projectionType?: ProjectionType, scope?: ProjectionScope): Promise<void> {
    if (projectionType === undefined && scope === undefined) {
      this.entries.clear();
      return;
    }
    const prefix = projectionType !== undefined ? `${projectionType}|` : '';
    const scopeJson = scope !== undefined ? JSON.stringify(scope) : undefined;
    for (const key of this.entries.keys()) {
      if (key.startsWith(prefix) && (scopeJson === undefined || key.includes(scopeJson))) {
        this.entries.delete(key);
      }
    }
  }

  private key(projectionType: ProjectionType, scope: ProjectionScope): string {
    return `${projectionType}|${JSON.stringify(scope)}`;
  }
}
