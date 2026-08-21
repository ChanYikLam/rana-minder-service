import { Injectable } from '@nestjs/common';
import type { FileRecord } from '../domain/models/file-model';
import type { FileRepository } from './file-repository';

/**
 * 进程内文件仓储（开发期占位；生产替换为 PostgreSQL 实现）。
 * 语义：只保存元数据/引用/状态，不承载授权（IFC-DATA-012 同源原则）。
 */
@Injectable()
export class InMemoryFileRepository implements FileRepository {
  private readonly files = new Map<string, FileRecord>();

  async save(file: FileRecord): Promise<void> {
    this.files.set(file.fileId, file);
  }

  async load(fileId: string): Promise<FileRecord | null> {
    return this.files.get(fileId) ?? null;
  }

  async listByTarget(target: {
    objectType: string;
    objectId: string;
    fieldKey: string;
  }): Promise<readonly FileRecord[]> {
    const result: FileRecord[] = [];
    for (const file of this.files.values()) {
      const t = file.target;
      if (
        t !== null &&
        t.objectType === target.objectType &&
        t.objectId === target.objectId &&
        t.fieldKey === target.fieldKey
      ) {
        result.push(file);
      }
    }
    return result;
  }

  async nextVersionNo(fileId: string): Promise<number> {
    const existing = this.files.get(fileId);
    return existing === undefined ? 1 : existing.versions.length + 1;
  }
}
