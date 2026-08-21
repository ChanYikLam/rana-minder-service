import type { FileRecord } from '../domain/models/file-model';

/** 文件仓储注入令牌（FileRepository 为接口，注入须用显式 token） */
export const FILE_REPOSITORY = Symbol('FILE_REPOSITORY');

/**
 * 文件元数据仓储（PostgreSQL 适配；DATA-FIL-001）。
 *
 * 保存文件逻辑记录、不可变版本、检查状态与定位信息；
 * 对象存储对字节负责，但不能决定业务归属、可见性或访问权限（ADR-008 §2.2）。
 */
export interface FileRepository {
  save(file: FileRecord): Promise<void>;
  load(fileId: string): Promise<FileRecord | null>;
  /** 按目标对象/字段列出文件（绑定/清理竞争用） */
  listByTarget(target: {
    objectType: string;
    objectId: string;
    fieldKey: string;
  }): Promise<readonly FileRecord[]>;
  /**
   * 原子创建：在目标字段附件数量上限内保存文件并返回 true；已满则返回 false。
   * 计数与保存必须在同一事务/同步执行段内完成，杜绝"先查后改"的 TOCTOU 竞态
   * （并发 InitiateUpload 不得突破 configuredPerField）。生产 PostgreSQL 适配时
   * 应配合 `(objectType, objectId, fieldKey)` 唯一索引/乐观锁在同一事务内实现。
   */
  createWithinTargetLimit(
    target: {
      objectType: string;
      objectId: string;
      fieldKey: string;
    },
    configuredPerField: number,
    file: FileRecord,
  ): Promise<boolean>;
  /** 下一版本号（不可变版本递增） */
  nextVersionNo(fileId: string): Promise<number>;
}
