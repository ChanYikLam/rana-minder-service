import { Inject, Injectable } from '@nestjs/common';
import { AuditEventType, AuditOutcome } from '../../domain/models/audit-event';
import type { TemporaryItem, TemporaryItemKind } from '../../domain/models/deletion';
import { AuditWriter } from './audit-writer';

/** 临时清理执行器注入令牌（RetentionCleanupExecutorPort 为接口，注入须用显式 token） */
export const RETENTION_CLEANUP_EXECUTOR = Symbol('RETENTION_CLEANUP_EXECUTOR');

/** 临时清理执行器端口（未提交草稿/扫描失败/无引用上传/临时导出；生产接真实清理适配） */
export interface RetentionCleanupExecutorPort {
  /** 删除并回读核验（I2 评审意见：实际删除由命令内完成，非调用方） */
  deleteAndVerify(itemId: string, kind: TemporaryItemKind): Promise<{ ok: boolean }>;
}

/**
 * 占位实现（开发期占位；生产接真实清理执行器）。
 *
 * **fail-closed**：未接入真实清理执行器时，直接清理并回读核验会抛错，而非恒返回
 * `{ok:true}`，避免“假清理 + 误导性 SUCCESS 审计”被静默确认（评审 critical）。
 * 接线分支须在接入真实清理适配后再启用命令，否则清理即失败（安全兜底）。
 */
@Injectable()
export class DefaultRetentionCleanupExecutor implements RetentionCleanupExecutorPort {
  async deleteAndVerify(_itemId: string, _kind: TemporaryItemKind): Promise<{ ok: boolean }> {
    throw new Error('清理执行器未接线（占位实现 fail-closed）：请先接入真实临时清理执行器');
  }
}

/** 临时清理输入（AUD-007/009） */
export interface RetentionCleanupInput {
  readonly items: readonly TemporaryItem[];
  /** 审计上下文（可选；供清理审计留痕溯源，缺省用系统任务占位） */
  readonly audit?: {
    readonly actorId: string;
    readonly source: { channel: 'WEB' | 'ADMIN' | 'SYSTEM_TASK' | 'BATCH' };
    readonly requestId: string;
  };
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
 * - **结果进审计**（评审意见）：本命令内注入 AuditWriter，每项成功清理落一条
 *   RETENTION 审计留痕，杜绝“实际删除却无审计”缺口（AUD-007/009）。
 */
@Injectable()
export class RetentionCleanupCommand {
  constructor(
    @Inject(RETENTION_CLEANUP_EXECUTOR) private readonly executor: RetentionCleanupExecutorPort,
    private readonly auditWriter: AuditWriter,
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
        // 实际删除 + 回读核验成功 → 落审计留痕（AUD-007/009；仅内部标识/类型，不含正文）
        // 语义：保留期清理属平台级保留策略操作（AUD-007），非超管敏感操作。
        // 由显式 audit 上下文驱动的清理（如超管手动触发）标注 SUPER_ADMIN；
        // 缺省的系统任务/自动清理标注 SYSTEM_TASK，避免把 system 操作误记为超管角色。
        const isSystemRun = input.audit === undefined;
        await this.auditWriter.write({
          eventType: AuditEventType.SUPER_ADMIN_OP,
          actorId: input.audit?.actorId ?? 'system',
          actorRoles: isSystemRun ? ['SYSTEM_TASK'] : ['SUPER_ADMIN'],
          scope: null,
          source: input.audit?.source ?? { channel: 'SYSTEM_TASK' },
          target: { objectType: `RETENTION_${item.kind}`, objectId: item.itemId },
          oldValues: null,
          newValues: { kind: item.kind, retained: false },
          outcome: AuditOutcome.SUCCESS,
          requestId: input.audit?.requestId ?? `retention-${item.itemId}`,
        });
      } else {
        // 删除/核验失败：保持未清理（重试任务收敛）
        skipped.push(item.itemId);
      }
    }
    return { cleaned, skipped };
  }
}
