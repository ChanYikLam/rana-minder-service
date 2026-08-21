/**
 * 水印策略（FORM-008、GOV-008、AUD-004）。
 *
 * 招新报名/面试材料等敏感附件的预览/下载默认加**查看者与时间**水印；
 * 普通文件按业务字段配置决定。
 */
export interface WatermarkDecision {
  /** 是否必须加水印 */
  readonly required: boolean;
  /** 水印内容（查看者 + 时间；脱敏，不含敏感正文） */
  readonly content: string;
}

/**
 * 敏感附件类别（招新报名/面试材料等；首版按类别与字段键判定）。
 */
const SENSITIVE_CATEGORIES = new Set<FileCategoryKey>(['PHOTO', 'GENERIC']);

type FileCategoryKey = 'PHOTO' | 'VIDEO' | 'GENERIC';

/** 敏感字段键前缀（招新报名/面试材料等字段） */
const SENSITIVE_FIELD_PREFIXES = ['resume', 'interview', 'material', 'photo', 'idPhoto'];

/**
 * 水印策略（纯规则）。
 */
export class WatermarkPolicy {
  /**
   * 判定是否必须加水印并生成内容。
   *
   * @param category 文件类别
   * @param fieldKey 附件字段键
   * @param sensitive 是否已标记敏感（调用方业务标记）
   * @param principalId 查看者（水印内容）
   * @param occurredAt 访问时间（ISO 8601；服务端可信时钟）
   * @param action 预览/下载（水印均应用）
   */
  decide(
    category: string,
    fieldKey: string,
    sensitive: boolean,
    principalId: string,
    occurredAt: string,
  ): WatermarkDecision {
    const sensitiveByCategory = SENSITIVE_CATEGORIES.has(category as FileCategoryKey);
    const sensitiveByField = SENSITIVE_FIELD_PREFIXES.some((p) =>
      fieldKey.toLowerCase().startsWith(p),
    );
    if (!sensitive && !sensitiveByCategory && !sensitiveByField) {
      return { required: false, content: '' };
    }
    return {
      required: true,
      content: `查看者:${principalId} 时间:${occurredAt}`,
    };
  }
}
