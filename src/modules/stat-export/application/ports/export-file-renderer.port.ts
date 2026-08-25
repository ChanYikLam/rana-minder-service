/**
 * 导出文件渲染端口（5.4.4，EXP-002：导出文件安全与水印内嵌）。
 *
 * 生成命令组装渲染计划（工作表 + 水印 + 附件 + 清单口径），由实现决定最终形态：
 * - 无附件 → 单一 XLSX（每数据集一个工作表，水印固化进 docProps/core.xml）；
 * - 有附件 → 内层 XLSX + 附件 + 导出清单 manifest.json 打包为 ZIP（EXP-002
 *   「附件包须附导出清单」）。
 *
 * 渲染是纯转换边界：同输入（含注入 now）输出确定；公式逃逸与 XML 转义在底层
 * 写入器内收口（escapeExportCell 领域策略），本端口不再重复处理。
 */

import type { ExportWatermarkMetadata } from '../../domain/services/export-watermark.policy';

/** 单个工作表渲染条目 */
export interface ExportRenderSheet {
  readonly name: string;
  readonly rows: ReadonlyArray<readonly unknown[]>;
}

/** 待打包附件（生成阶段按快照 attachmentRefs 回源所得；EXP-002 显式选择才打包） */
export interface ExportRenderAttachment {
  /** 事实源返回的稳定引用（写入导出清单的 ref 字段） */
  readonly ref: string;
  readonly filename: string;
  readonly contentType: string | null;
  readonly bytes: Uint8Array;
}

/** 导出清单的数据集口径段（EXP-002：数据集名 + 字段计数） */
export interface ExportManifestDatasetRef {
  readonly dataset: string;
  readonly fieldCount: number;
}

/** 渲染计划（生成命令按冻结快照组装） */
export interface ExportRenderPlan {
  readonly sheets: ReadonlyArray<ExportRenderSheet>;
  readonly watermark: ExportWatermarkMetadata;
  readonly attachments: ReadonlyArray<ExportRenderAttachment>;
  /** 导出清单数据集口径（附件打包时写入 manifest.json；EXP-002） */
  readonly datasets: ReadonlyArray<ExportManifestDatasetRef>;
  /** 服务端可信时钟（注入后产物字节级确定） */
  readonly now: Date;
}

export interface ExportFileRendererPort {
  render(plan: ExportRenderPlan): Promise<{ kind: 'xlsx' | 'zip'; bytes: Uint8Array }>;
}

export const EXPORT_FILE_RENDERER_PORT = Symbol('EXPORT_FILE_RENDERER_PORT');
