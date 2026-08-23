import { Injectable } from '@nestjs/common';
import type { ArchiveRecord } from '../domain/models/archive';

/** 归档仓储注入令牌（ArchiveRepository 为接口，注入须用显式 token） */
export const ARCHIVE_REPOSITORY = Symbol('ARCHIVE_REPOSITORY');

/**
 * 归档仓储（PostgreSQL 适配；AUD-004）。
 *
 * 归档只读：只提供保存与加载，不提供修改/删除方法；
 * 参与关系与社团启用状态为锁定快照。
 */
export interface ArchiveRepository {
  save(archive: ArchiveRecord): Promise<void>;
  load(activityId: string): Promise<ArchiveRecord | null>;
}

/** 进程内实现（开发期占位） */
@Injectable()
export class InMemoryArchiveRepository implements ArchiveRepository {
  private readonly archives = new Map<string, ArchiveRecord>();

  async save(archive: ArchiveRecord): Promise<void> {
    this.archives.set(archive.activityId, archive);
  }

  async load(activityId: string): Promise<ArchiveRecord | null> {
    return this.archives.get(activityId) ?? null;
  }
}
