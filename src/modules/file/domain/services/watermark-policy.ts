import type { FileCategory } from '../models/file-model';

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
 * 仅照片类别默认敏感；普通文件（GENERIC）按字段键与敏感标记判定，避免过宽。
 */
const SENSITIVE_CATEGORIES = new Set<FileCategory>(['PHOTO']);

/** 敏感字段键前缀（小写匹配；招新报名/面试材料等字段） */
const SENSITIVE_FIELD_PREFIXES = ['resume', 'interview', 'material', 'photo', 'idphoto'];

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
   * @param principalId 查看者（水印内容，脱敏后嵌入）
   * @param occurredAt 访问时间（ISO 8601；服务端可信时钟）
   */
  decide(
    category: FileCategory,
    fieldKey: string,
    sensitive: boolean,
    principalId: string,
    occurredAt: string,
  ): WatermarkDecision {
    const sensitiveByCategory = SENSITIVE_CATEGORIES.has(category);
    const sensitiveByField = SENSITIVE_FIELD_PREFIXES.some((p) =>
      fieldKey.toLowerCase().startsWith(p),
    );
    if (!sensitive && !sensitiveByCategory && !sensitiveByField) {
      return { required: false, content: '' };
    }
    return {
      required: true,
      content: `查看者:${maskPrincipal(principalId)} 时间:${occurredAt}`,
    };
  }
}

/**
 * 对查看者标识脱敏：仅保留头部若干位 + 稳定短哈希，避免完整内部标识
 * 经水印渲染/截图传播而泄露（GOV-008）。
 *
 * ⚠️ 非密码学安全用途：此为**展示性脱敏**，仅用于水印可读性/追溯，
 * 乘法哈希可被逆向碰撞，**不得**用于鉴权、签名或任何安全校验场景。
 */
function maskPrincipal(principalId: string): string {
  const head = principalId.slice(0, 4);
  let hash = 0;
  for (let i = 0; i < principalId.length; i++) {
    hash = (hash * 31 + principalId.charCodeAt(i)) >>> 0;
  }
  return `${head}****${hash.toString(16).slice(0, 4)}`;
}
