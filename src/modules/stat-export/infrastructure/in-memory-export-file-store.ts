/**
 * 内存导出文件存储桩（开发与单测用，5.4.4）。
 *
 * 同时实现两个端口（同一实例绑定，保证 dispose 能删除 write 写入的文件）：
 * - ExportFileWriterPort：对象存储写出边界（EXP-001/EXP-003），fileRef 形如
 *   `export-file://<exportId>/<exportNo>.<kind>`；
 * - ExportDisposalPort：删除文件并记录 disposed 引用（AUD-009 清理链路断言用）。
 *
 * 保留 files Map 与 disposed 清单供单测断言；生产替换为对象存储适配器。
 */

import {
  EXPORT_FILE_WRITER_PORT,
  type ExportFileWriteRequest,
  type ExportFileWriteResult,
  type ExportFileWriterPort,
} from '../application/ports/export-file-writer.port';
import {
  EXPORT_DISPOSAL_PORT,
  type ExportDisposalPort,
} from '../application/ports/export-disposal.port';
import type { ExportWatermarkMetadata } from '../domain/services/export-watermark.policy';

/** 已存储文件的元数据快照（断言用，不含完整字节以免测试输出膨胀） */
export interface StoredExportFile {
  readonly fileRef: string;
  readonly exportId: string;
  readonly exportNo: string;
  readonly kind: 'xlsx' | 'zip';
  readonly fileSize: number;
  readonly watermark: ExportWatermarkMetadata;
}

export class InMemoryExportFileStore implements ExportFileWriterPort, ExportDisposalPort {
  private readonly files = new Map<string, StoredExportFile>();
  private readonly disposedList: string[] = [];
  /** 已写入字节（按 fileRef；供内容级断言；dispose 后移除） */
  private readonly bytesByRef = new Map<string, Uint8Array>();

  async write(req: ExportFileWriteRequest): Promise<ExportFileWriteResult> {
    const fileRef = `export-file://${req.exportId}/${req.exportNo}.${req.kind}`;
    const fileSize = req.bytes.byteLength;
    this.files.set(fileRef, {
      fileRef,
      exportId: req.exportId,
      exportNo: req.exportNo,
      kind: req.kind,
      fileSize,
      watermark: { ...req.watermark },
    });
    this.bytesByRef.set(fileRef, req.bytes);
    return { fileRef, fileSize };
  }

  async dispose(fileRef: string): Promise<void> {
    // 幂等语义：引用不存在视为已删除，不抛错（重复清理/并发清理安全）
    if (this.files.delete(fileRef)) {
      this.disposedList.push(fileRef);
    }
    this.bytesByRef.delete(fileRef);
  }

  /** 测试辅助：当前已存储文件元数据清单 */
  get stored(): readonly StoredExportFile[] {
    return [...this.files.values()];
  }

  /** 测试辅助：按 fileRef 查找已存储文件元数据 */
  find(fileRef: string): StoredExportFile | undefined {
    return this.files.get(fileRef);
  }

  /** 测试辅助：按 fileRef 取回写入字节（内容级断言用） */
  bytesOf(fileRef: string): Uint8Array | undefined {
    return this.bytesByRef.get(fileRef);
  }

  /** 测试辅助：已被 dispose 的引用清单（按调用序） */
  get disposed(): readonly string[] {
    return [...this.disposedList];
  }
}

export { EXPORT_FILE_WRITER_PORT, EXPORT_DISPOSAL_PORT };
