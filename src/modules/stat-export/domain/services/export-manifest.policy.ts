/**
 * 导出清单策略（5.4.4，EXP-002：附件包须附导出清单）。
 *
 * 附件打包（ZIP）时随包固化一份机器可读导出清单，承载溯源四要素
 * （导出编号/导出人/所属社团/生成时间）+ 数据集与字段计数 + 附件文件清单，
 * 使离线包在脱离系统上下文后仍可对账"包内有什么、谁在何时导出"。
 *
 * 纯函数实现：同输入输出逐字段一致、键序确定（便于字节级 diff 与快照测试）；
 * 不做 IO、不改写入参。分层约束：领域层纯规则，禁止依赖 @nestjs/* 与基础设施。
 */

import type { ExportWatermarkMetadata } from './export-watermark.policy';

/** 清单可序列化值（JSON 兼容子集；只读视图） */
export type JsonValue =
  string | number | boolean | null | readonly JsonValue[] | { readonly [key: string]: JsonValue };

/** 清单中的数据集口径段 */
export interface ExportManifestDataset {
  readonly dataset: string;
  readonly fieldCount: number;
}

/** 清单中的附件文件条目 */
export interface ExportManifestAttachment {
  readonly filename: string;
  readonly ref: string;
  readonly byteLength: number;
}

/** 清单清单版本号：清单结构不兼容变更时递增（对账方按版本解析） */
export const EXPORT_MANIFEST_VERSION = 1;

/**
 * 导出清单结构（机器可读；JSON 序列化后写入附件包 manifest.json）。
 * 键位固定，便于对账方按固定键解析（缺省要素以 null 占位保留键位）。
 */
export interface ExportManifest {
  readonly manifestVersion: number;
  readonly exportNo: string;
  readonly exporterUserId: string;
  readonly exporterName: string | null;
  readonly clubId: string | null;
  readonly clubName: string | null;
  readonly generatedAtIso: string;
  readonly watermarkText: string;
  readonly datasets: ReadonlyArray<{ readonly dataset: string; readonly fieldCount: number }>;
  readonly attachments: ReadonlyArray<{
    readonly filename: string;
    readonly ref: string;
    readonly byteLength: number;
  }>;
}

/**
 * 组装导出清单（EXP-002）。
 *
 * 键序固定为：manifestVersion → 溯源四要素（exportNo/exporter/exporterName/
 * clubId/clubName/generatedAtIso/watermarkText）→ datasets → attachments。
 * 入参数组仅被读取并拷贝，函数不持有/改写调用方数据。
 */
export function buildExportManifest(input: {
  readonly watermark: ExportWatermarkMetadata;
  readonly datasets: readonly ExportManifestDataset[];
  readonly attachments: readonly ExportManifestAttachment[];
  /** 清单生成时间（与文件内水印 generatedAtIso 同源，保证包内时间口径一致） */
  readonly generatedAtIso: string;
}): ExportManifest {
  const wm = input.watermark;
  return {
    manifestVersion: EXPORT_MANIFEST_VERSION,
    exportNo: wm.exportNo,
    exporterUserId: wm.exporterUserId,
    exporterName: wm.exporterName,
    clubId: wm.clubId,
    clubName: wm.clubName,
    generatedAtIso: input.generatedAtIso,
    watermarkText: wm.watermarkText,
    datasets: input.datasets.map((d) => ({ dataset: d.dataset, fieldCount: d.fieldCount })),
    attachments: input.attachments.map((a) => ({
      filename: a.filename,
      ref: a.ref,
      byteLength: a.byteLength,
    })),
  };
}
