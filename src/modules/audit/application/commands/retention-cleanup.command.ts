import { Inject, Injectable } from '@nestjs/common';
import type { TemporaryItemKind } from '../../domain/models/deletion';

/** 临时清理执行器注入令牌（RetentionCleanupExecutorPort 为接口，注入须用显式 token） */
export const RETENTION_CLEANUP_EXECUTOR = Symbol('RETENTION_CLEANUP_EXECUTOR');

/** 临时清理执行器端口（未提交草稿/扫描失败/无引用上传/临时导出；生产接真实清理适配） */
export interface RetentionCleanupExecutorPort {
  /** 删除并回读核验（I2 评审意见：实际删除由命令内完成，非调用方） */
  deleteAndVerify(itemId: string, kind: TemporaryItemKind): Promise<{ ok: boolean }>;
}

/** 占位实现（开发期直接确认；生产接真实清理执行器） */
@Injectable()
export class DefaultRetentionCleanupExecutor implements RetentionCleanupExecutorPort {
  async deleteAndVerify(_itemId: string, _kind: TemporaryItemKind): Promise<{ ok: boolean }> {
    return { ok: true };
  }
}

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
 * - 实际删除与**回读核验由命令内执行器完成**（I2 评审意见）；核验失败项保持
 *   未清理（skipped），由重试任务收敛；
 * - 结果进审计（调用方以 AuditWriter 记录；本命令只收口清理判定与执行）。
 */
@Injectable()
export class RetentionCleanupCommand {
  constructor(
    @Inject(RETENTION_CLEANUP_EXECUTOR) private readonly executor: RetentionCleanupExecutorPort,
  ) {}

  async execute(input: RetentionCleanupInput): Promise<RetentionCleanupResult> {
    const cleaned: string[] = [];
    const skipped: string[] = [];
    for (const item of input.items) {
      const eligible = item.retentionExpired && !item.hasValidReference;
      if (!eligible) {
        skipped.push(item.itemId);
        continue;
      }
      const result = await this.executor.deleteAndVerify(item.itemId, item.kind);
      if (result.ok) {
        cleaned.push(item.itemId);
      } else {
        // 删除/核验失败：保持未清理（重试任务收敛）
        skipped.push(item.itemId);
      }
    }
    return { cleaned, skipped };
  }
}
