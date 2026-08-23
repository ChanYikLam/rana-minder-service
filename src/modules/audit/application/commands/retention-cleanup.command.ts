import { Injectable } from '@nestjs/common';
import type { TemporaryItemKind } from '../../domain/models/deletion';

/** 临时清理输入（AUD-007/009） */
export interface RetentionCleanupInput {
  readonly items: readonly {
    readonly itemId: string;
    readonly kind: TemporaryItemKind;
    /** 期限已到（超管配置；调用方判定） */
    readonly retentionExpired: boolean;
    /** 清理前重查引用：无有效引用才可清理 */
    readonly hasValidReference: boolean;
  }[];
}

/** 清理结果 */
export interface RetentionCleanupResult {
  readonly cleaned: readonly string[];
  readonly skipped: readonly string[];
}

/**
 * 临时清理（RetentionCleanupCommand；AUD-007/009）。
 *
 * - 清理对象：未提交草稿/扫描失败文件/无有效引用上传/临时导出；
 * - 期限由超管配置；**清理前重查引用关系**（仍有有效引用 → 跳过）；
 * - 结果进审计（调用方以 AuditWriter 记录；本命令只收口清理判定）；
 * - **不建设匿名化**：临时清理只删临时/技术数据，不提供匿名化流程。
 */
@Injectable()
export class RetentionCleanupCommand {
  async execute(input: RetentionCleanupInput): Promise<RetentionCleanupResult> {
    const cleaned: string[] = [];
    const skipped: string[] = [];
    for (const item of input.items) {
      const eligible = item.retentionExpired && !item.hasValidReference;
      if (eligible) {
        cleaned.push(item.itemId);
      } else {
        skipped.push(item.itemId);
      }
    }
    return { cleaned, skipped };
  }
}
