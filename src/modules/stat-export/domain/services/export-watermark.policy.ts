/**
 * 导出水印元数据策略（5.4.3，EXP-002：导出文件须内嵌水印/元数据）。
 *
 * 每份导出文件（XLSX/ZIP）在生成时固化一份水印元数据，用于泄露溯源：
 * - 导出编号（exportNo）：EXP-<yyyymmdd>-<exportId 前 8 位大写>-<修订号 4 位补零>；
 * - 导出人（userId + 姓名）、所属社团、生成时间；
 * - watermarkText：把上述要素拼装为带中文标签的单行文本，写入文件属性
 *   （docProps/core.xml）并可供页面级水印渲染复用。
 *
 * 纯函数实现：同一输入永远得到同一输出；日期取号统一使用 generatedAt 的
 * UTC 日历日，避免运行时时区影响导出编号的确定性。
 * 分层约束：本文件为领域层纯规则，禁止依赖 @nestjs/* 与基础设施实现。
 */

/** 导出水印输入（生成管线在任务领取时组装） */
export interface ExportWatermarkInput {
  /** 导出任务 ID（导出编号取其前 8 位大写） */
  readonly exportId: string;
  /** 导出修订号（重试沿用原快照递增；4 位补零进导出编号） */
  readonly revisionNumber: number;
  /** 导出人用户 ID */
  readonly exporterUserId: string;
  /** 导出人姓名（缺省 null，watermarkText 回退为 userId） */
  readonly exporterName?: string | null;
  /** 所属社团 ID（平台级/个人副本等无社团场景为空） */
  readonly clubId?: string | null;
  /** 所属社团名称（缺省 null） */
  readonly clubName?: string | null;
  /** 生成时间（服务端可信时钟） */
  readonly generatedAt: Date;
}

/** 固化到导出文件内的水印元数据（不可变） */
export interface ExportWatermarkMetadata {
  /** 导出编号：EXP-yyyymmdd-exportId 前 8 位大写-revisionNumber 补零 4 位 */
  readonly exportNo: string;
  readonly exporterUserId: string;
  readonly exporterName: string | null;
  readonly clubId: string | null;
  readonly clubName: string | null;
  /** 生成时间 ISO 8601（generatedAt.toISOString()） */
  readonly generatedAtIso: string;
  /**
   * 单行水印文本，含四个带标签段落：
   * 导出人 / 所属社团 / 生成时间 / 导出编号。
   */
  readonly watermarkText: string;
}

/**
 * 由 exportId + 修订号 + 生成时间推导导出编号。
 *
 * 格式：`EXP-<yyyymmdd>-<exportId 前 8 位大写>-<revisionNumber 补零 4 位>`。
 * 日期段取 generatedAt 的 UTC 日历日（确定性口径）；revisionNumber 小数部分
 * 向下取整后补零，负数按 0000 处理（防御性兜底，正常管线不会出现）。
 */
export function buildExportNumber(
  input: Pick<ExportWatermarkInput, 'exportId' | 'revisionNumber' | 'generatedAt'>,
): string {
  const at = input.generatedAt;
  const year = String(at.getUTCFullYear()).padStart(4, '0');
  const month = String(at.getUTCMonth() + 1).padStart(2, '0');
  const day = String(at.getUTCDate()).padStart(2, '0');
  const idHead = input.exportId.slice(0, 8).toUpperCase();
  const revision = Math.max(0, Math.floor(input.revisionNumber));
  return `EXP-${year}${month}${day}-${idHead}-${String(revision).padStart(4, '0')}`;
}

/**
 * 组装导出水印元数据（纯函数；同一输入输出逐字段相等）。
 *
 * watermarkText 形如：
 * `导出人:张三(u-123)｜所属社团:篮球协会(c-9)｜生成时间:2026-...｜导出编号:EXP-...`
 * 缺失的可选要素以占位文本呈现，保证四段标签始终存在（溯源口径固定）。
 */
export function buildExportWatermarkMetadata(input: ExportWatermarkInput): ExportWatermarkMetadata {
  const exportNo = buildExportNumber(input);
  const exporterName = input.exporterName ?? null;
  const clubId = input.clubId ?? null;
  const clubName = input.clubName ?? null;
  const generatedAtIso = input.generatedAt.toISOString();

  const exporterLabel = exporterName
    ? `${exporterName}(${input.exporterUserId})`
    : input.exporterUserId;
  const clubLabel =
    clubName || clubId
      ? `${clubName ?? ''}${clubName && clubId ? '(' : ''}${clubId ?? ''}${
          clubName && clubId ? ')' : ''
        }`
      : '未关联社团';

  const watermarkText = [
    `导出人:${exporterLabel}`,
    `所属社团:${clubLabel}`,
    `生成时间:${generatedAtIso}`,
    `导出编号:${exportNo}`,
  ].join('｜');

  return {
    exportNo,
    exporterUserId: input.exporterUserId,
    exporterName,
    clubId,
    clubName,
    generatedAtIso,
    watermarkText,
  };
}
