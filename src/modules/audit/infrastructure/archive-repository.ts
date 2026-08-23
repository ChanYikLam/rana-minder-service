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
  /** 原子创建：不存在则保存并返回 null；已存在返回原记录（不覆盖）。生产以唯一键 upsert 实现 */
  createIfAbsent(archive: ArchiveRecord): Promise<ArchiveRecord | null>;
  load(activityId: string): Promise<ArchiveRecord | null>;
}

/** 进程内实现（开发期占位；createIfAbsent 以同步段内查重实现原子语义） */
@Injectable()
export class InMemoryArchiveRepository implements ArchiveRepository {
  private readonly archives = new Map<string, ArchiveRecord>();

  async createIfAbsent(archive: ArchiveRecord): Promise<ArchiveRecord | null> {
    if (this.archives.has(archive.activityId)) {
      return this.archives.get(archive.activityId) ?? null;
    }
    this.archives.set(archive.activityId, archive);
    return null;
  }

  async load(activityId: string): Promise<ArchiveRecord | null> {
    return this.archives.get(activityId) ?? null;
  }
}
