/**
 * 导出文件渲染器（基础设施实现，5.4.4，EXP-002）。
 *
 * 实现 ExportFileRendererPort：
 * - 无附件 → 单一 XLSX（每数据集一个工作表；水印经 XlsxWriter.create 固化进
 *   docProps/core.xml，公式逃逸由写入器内部收口）；
 * - 有附件 → 先构建内层 XLSX（导出数据.xlsx），再用 ZipWriter 打包：
 *   `导出数据.xlsx` + `attachments/<filename>` 条目 + 由 buildExportManifest
 *   生成的 `manifest.json` 导出清单（EXP-002「附件包须附导出清单」）。
 *
 * 确定性：注入同一 now 时产物字节级一致（底层写入器已按 UTC 拆分时间戳）。
 * 分层说明：本文件属基础设施层，允许依赖领域层策略（不得反向）。
 */

import {
  EXPORT_FILE_RENDERER_PORT,
  type ExportFileRendererPort,
  type ExportRenderPlan,
} from '../../application/ports/export-file-renderer.port';
import { buildExportManifest } from '../../domain/services/export-manifest.policy';
import { ZipWriter, assertSafeZipEntryName } from './zip-writer';
import { XlsxWriter } from './xlsx-writer';

/** ZIP 包内固定条目名：内层数据表与清单 */
export const EXPORT_ZIP_DATA_ENTRY = '导出数据.xlsx';
export const EXPORT_ZIP_MANIFEST_ENTRY = 'manifest.json';
/** 附件条目前缀（ZIP 内相对路径） */
export const EXPORT_ZIP_ATTACHMENTS_PREFIX = 'attachments/';

/**
 * 附件 ZIP 条目文件名归一化（5.4.3，EXP-002：防 Zip Slip）。
 *
 * 附件 filename 来自上传/回源适配器（用户可控），不得原样拼进 ZIP 条目：
 * - 只取最后一个路径段（按 `/` 与 `\` 均切分）作为 basename，剥离
 *   `../`、绝对路径、Windows 盘符等路径形态；
 * - 归一化后仍不通过 assertSafeZipEntryName（控制字符/残留穿越段）→
 *   回退为基于 ref 的稳定名 `att-<ref 尾部>`，保证导出不因单个异常文件名
 *   整体失败（fail-safe 且不泄露原始路径结构）。
 */
export function safeAttachmentEntryName(filename: string, ref: string): string {
  const basename = filename.split(/[\\/]/).filter(Boolean).pop() ?? '';
  if (basename.length === 0) {
    return `att-${ref.split('/').filter(Boolean).pop() ?? 'file'}`;
  }
  try {
    assertSafeZipEntryName(basename);
    return basename;
  } catch {
    return `att-${ref.split('/').filter(Boolean).pop() ?? 'file'}`;
  }
}

export class XlsxExportFileRenderer implements ExportFileRendererPort {
  async render(plan: ExportRenderPlan): Promise<{ kind: 'xlsx' | 'zip'; bytes: Uint8Array }> {
    if (plan.sheets.length === 0) {
      throw new Error('EXP-002: 渲染计划至少需要一个工作表');
    }

    // 内层 XLSX：水印元数据固化进 docProps/core.xml（EXP-002）
    const writer = XlsxWriter.create(plan.watermark, { now: plan.now });
    for (const sheet of plan.sheets) {
      writer.addSheet(sheet.name, sheet.rows);
    }
    const dataBytes = writer.build();

    if (plan.attachments.length === 0) {
      return { kind: 'xlsx', bytes: dataBytes };
    }

    // 附件包：数据表 + attachments/<安全 basename> + manifest.json（EXP-002 清单）
    const zip = new ZipWriter({ now: plan.now });
    zip.add({ filename: EXPORT_ZIP_DATA_ENTRY, data: dataBytes });
    for (const attachment of plan.attachments) {
      zip.add({
        filename: `${EXPORT_ZIP_ATTACHMENTS_PREFIX}${safeAttachmentEntryName(
          attachment.filename,
          attachment.ref,
        )}`,
        data: attachment.bytes,
      });
    }
    zip.add({
      filename: EXPORT_ZIP_MANIFEST_ENTRY,
      data: JSON.stringify(
        buildExportManifest({
          watermark: plan.watermark,
          datasets: plan.datasets,
          attachments: plan.attachments.map((a) => ({
            filename: a.filename,
            ref: a.ref,
            byteLength: a.bytes.byteLength,
          })),
          generatedAtIso: plan.watermark.generatedAtIso,
        }),
        null,
        2,
      ),
    });
    return { kind: 'zip', bytes: zip.build() };
  }
}

export { EXPORT_FILE_RENDERER_PORT };
