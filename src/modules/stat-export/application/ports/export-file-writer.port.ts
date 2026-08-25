/**
 * 导出文件写出端口（5.4.4，EXP-001/EXP-003：对象存储边界）。
 *
 * 生成管线渲染出的最终字节流（XLSX 或 ZIP 附件包）经本端口落入对象存储，
 * 返回稳定 fileRef 回填任务聚合（fileRef 为下载端口签发短链的定位依据）。
 * 水印元数据一并透传，供生产适配器写入对象元数据（溯源口径与文件内嵌水印一致，
 * EXP-002）。生产适配器接对象存储；内存桩见 InMemoryExportFileStore。
 */

import type { ExportWatermarkMetadata } from '../../domain/services/export-watermark.policy';

/** 导出文件写出入参 */
export interface ExportFileWriteRequest {
  /** 导出任务 ID（fileRef 路径段） */
  readonly exportId: string;
  /** 导出编号（fileRef 文件名段；来自水印元数据，保证可读溯源） */
  readonly exportNo: string;
  /** 渲染产物类型：xlsx = 纯数据表；zip = 数据表 + 附件包（EXP-002） */
  readonly kind: 'xlsx' | 'zip';
  readonly bytes: Uint8Array;
  /** 固化进对象元数据的水印要素（EXP-002） */
  readonly watermark: ExportWatermarkMetadata;
}

/** 导出文件写出结果 */
export interface ExportFileWriteResult {
  /** 对象存储引用（回填任务聚合 fileRef） */
  readonly fileRef: string;
  /** 字节长度（与任务聚合 fileSize 一致） */
  readonly fileSize: number;
}

export interface ExportFileWriterPort {
  write(req: ExportFileWriteRequest): Promise<ExportFileWriteResult>;
}

export const EXPORT_FILE_WRITER_PORT = Symbol('EXPORT_FILE_WRITER_PORT');
