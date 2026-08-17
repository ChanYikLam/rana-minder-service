import { Injectable } from '@nestjs/common';
import type { ProjectionRecord, ProjectionScope, ProjectionType } from '../contracts';
import { ProjectionRecordStatus } from '../contracts';
import type { ProjectionStore } from './projection-store';

/**
 * 进程内投影存储（可重建缓存载体占位，ADR-007）。
 *
 * 语义：全部丢失/过期/清空时必须能从权威来源重建出相同结果；
 * 只保存可重建派生数据，不承载授权（IFC-DATA-012）。
 * 单实例/开发期占位：多实例共享或持久化需求出现时替换为
 * PostgreSQL 投影实现（基础设施任务）。
 */
@Injectable()
export class InMemoryProjectionStore implements ProjectionStore {
  private readonly records = new Map<string, ProjectionRecord>();

  async save<TData>(record: ProjectionRecord<TData>): Promise<void> {
    this.records.set(this.key(record.projectionType, record.watermark.scope), record);
  }

  async load<TData>(
    projectionType: ProjectionType,
    scope: ProjectionScope,
  ): Promise<ProjectionRecord<TData> | null> {
    const record = this.records.get(this.key(projectionType, scope));
    if (record === undefined || record.status !== ProjectionRecordStatus.ACTIVE) {
      return null;
    }
    return record as ProjectionRecord<TData>;
  }

  async invalidate(
    projectionType: ProjectionType,
    scope: ProjectionScope,
    invalidatedAt: string,
    rebuildBasis: string,
  ): Promise<void> {
    const existing = this.records.get(this.key(projectionType, scope));
    if (existing === undefined) {
      return;
    }
    this.records.set(this.key(projectionType, scope), {
      ...existing,
      status: ProjectionRecordStatus.INVALIDATED,
      invalidatedAt,
      rebuildBasis,
    });
  }

  async findByScope<TData>(
    projectionType: ProjectionType,
    scope: ProjectionScope,
  ): Promise<readonly ProjectionRecord<TData>[]> {
    const prefix = `${projectionType}|`;
    const scopeJson = JSON.stringify(scope);
    const result: ProjectionRecord<TData>[] = [];
    for (const [key, record] of this.records) {
      if (key.startsWith(prefix) && key.includes(scopeJson)) {
        result.push(record as ProjectionRecord<TData>);
      }
    }
    return result;
  }

  private key(projectionType: ProjectionType, scope: ProjectionScope): string {
    return `${projectionType}|${JSON.stringify(scope)}`;
  }
}
