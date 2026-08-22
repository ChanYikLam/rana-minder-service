import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { AuditEventType, AuditOutcome } from '../../domain/models/audit-event';
import type { AuditEvent, AuditSource } from '../../domain/models/audit-event';
import { AuditSanitizer } from '../../domain/services/audit-sanitizer';
import { AUDIT_REPOSITORY } from '../../infrastructure/audit-repository';
import type { AuditRepository } from '../../infrastructure/audit-repository';

/** 审计写入输入（AuditWriter；AUD-003） */
export interface AuditWriteInput {
  readonly eventType: AuditEventType;
  readonly actorId: string;
  readonly actorRoles: readonly string[];
  readonly scope: { kind: string; clubId?: string; unionId?: string } | null;
  readonly source: AuditSource;
  readonly target: { objectType: string; objectId: string } | null;
  /** 旧值/新值（敏感字段自动脱敏差异；密码/密钥/令牌/验证码/附件正文不落盘） */
  readonly oldValues?: Record<string, unknown> | null;
  readonly newValues?: Record<string, unknown> | null;
  readonly outcome: AuditOutcome;
  readonly failureReason?: string;
  readonly requestId: string;
  readonly occurredAt?: string;
}

/** 审计写入失败（关键审计写入失败 → 业务整体失败；AUD-003/IFC-TX-006） */
export class AuditWriteFailedError extends Error {
  constructor(message: string) {
    super(`IFC-ERR-012: ${message}`);
    this.name = 'AuditWriteFailedError';
  }
}

/**
 * 关键审计写入器（AuditWriter）。
 *
 * - 与业务**同一事务**保存（本命令写入失败 → 调用方关键操作整体失败；
 *   排队写审计视为失败，不得异步补写关键审计）；
 * - **敏感不落盘**：密码/邮箱密钥/令牌/验证码/附件正文只记脱敏差异；
 * - 审计只追加，不可修改/删除（仓储无此类方法）。
 */
@Injectable()
export class AuditWriter {
  constructor(
    @Inject(AUDIT_REPOSITORY) private readonly repo: AuditRepository,
    private readonly sanitizer: AuditSanitizer,
  ) {}

  async write(input: AuditWriteInput): Promise<AuditEvent> {
    const oldDiff = this.sanitizer.sanitizeObject(input.oldValues).oldValue;
    const newDiff = this.sanitizer.sanitizeObject(input.newValues).oldValue;
    const event: AuditEvent = {
      auditId: randomUUID(),
      eventType: input.eventType,
      actorId: input.actorId,
      actorRoles: input.actorRoles,
      scope: input.scope,
      occurredAt: input.occurredAt ?? new Date().toISOString(),
      source: input.source,
      target: input.target,
      oldValue: oldDiff,
      newValue: newDiff,
      outcome: input.outcome,
      failureReason: input.failureReason,
      requestId: input.requestId,
    };
    try {
      await this.repo.append(event);
    } catch (e) {
      // 关键审计写入失败 → 调用方业务必须整体失败（不得异步补写）
      throw new AuditWriteFailedError(
        `关键审计写入失败，业务操作不得成功：${e instanceof Error ? e.message : 'unknown'}`,
      );
    }
    return event;
  }
}
