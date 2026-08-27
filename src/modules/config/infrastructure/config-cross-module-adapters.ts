/**
 * config 跨模块能力端口的真实适配器（CFG-001/002/003/005 接线）。
 *
 * - AuditBackedConfigAudit（CFG-001 展示资料审计 / CFG-003 分界规则变更审计）：
 *   映射为 audit 模块 AuditWriter 的 AuditWriteInput。写入与业务同事务：
 *   在业务方（如 ConfigUnitOfWork）事务窗口内调用时经共享事务上下文借用同一
 *   TransactionContext，随外层原子提交；无外层事务时由 AuditUnitOfWork 自开
 *   短事务收口。写入失败抛 IFC-ERR-012 → 业务整体失败（AUD-003/IFC-TX-006）。
 *
 * - NotificationFactBackedConfigNotification（NTF-002 权益变化通知 /
 *   NTF-005 配置发布通知）：映射为 CreateNotificationFactInput，经 notification
 *   模块 CreateNotificationFactCommand 同事务保存事实（事件类型 'system'——
 *   管理类事件：事实持久化、收件人解析留给管理收件人计算基础设施；
 *   SRS-FAIL-009 kill-switch 暂停投递语义由命令内部处理）。
 *
 * 幂等契约（NTF-003 / PR #194 评审 warning）：逻辑事件标识确定性生成——
 * 发布通知 `cfg-published-<rootId>-v<versionNumber>`、策略变更
 * `cfg-policy-<scope>-<clubId>-<key>-<effectiveAt ms>`；保存前按 fact 级
 * dedup_key 预检（零收件人事实的 dedup_key 即 logicalEventId），重试不产生
 * 重复事实。通知失败沿命令异常上抛，调用方见失败但业务已落库（评审既定
 * 补偿语义：发布不可重放，仅记录待补偿）。
 */

import { randomUUID } from 'node:crypto';

import { AuditWriter } from '../../audit/application/commands/audit-writer';
import { AuditEventType, AuditOutcome } from '../../audit/domain/models/audit-event';
import { CreateNotificationFactCommand } from '../../notification/application/commands/create-notification-fact.command';
import type { CreateNotificationFactInput } from '../../notification/domain/models/notification-fact.model';
import type { NotificationRepository } from '../../notification/infrastructure/notification-ports';

import type { ClubProfileFieldChange } from '../domain/models/club-profile';
import type { PolicyKey } from '../domain/models/scoped-policy';
import type { ConfigKind } from '../domain/models/config-version';
import type { ConfigAuditPort, ConfigNotificationPort } from './not-wired.config-ports';

/** 变更留痕差异（脱敏由 AuditSanitizer 统一处理，本层不做二次脱敏） */
function diffPairs(
  changes: readonly ClubProfileFieldChange[],
  side: 'from' | 'to',
): Record<string, string> {
  const diff: Record<string, string> = {};
  for (const change of changes) {
    diff[change.field] = change[side];
  }
  return diff;
}

/** 审计背书配置审计（CFG-001/003；AUD-003 同事务） */
export class AuditBackedConfigAudit implements ConfigAuditPort {
  constructor(private readonly writer: AuditWriter) {}

  async recordProfileChange(input: {
    clubId: string;
    by: string;
    onBehalf: boolean;
    at: Date;
    changes: readonly ClubProfileFieldChange[];
  }): Promise<void> {
    await this.writer.write({
      eventType: AuditEventType.PROFILE_SYNC,
      actorId: input.by,
      // 角色快照沿用授权身份口径：PLATFORM=超管代改；否则负责人/人事本体修改
      actorRoles: [input.onBehalf ? 'PLATFORM' : 'OWNER'],
      scope: { kind: 'CLUB', clubId: input.clubId },
      source: { channel: 'ADMIN' },
      target: { objectType: 'CLUB_PROFILE', objectId: input.clubId },
      oldValues: diffPairs(input.changes, 'from'),
      newValues: diffPairs(input.changes, 'to'),
      outcome: AuditOutcome.SUCCESS,
      requestId: randomUUID(),
      occurredAt: input.at.toISOString(),
    });
  }

  /** CFG-003 分界规则变更审计（超管专属操作；旧/新分界留痕） */
  async recordBoundaryChange(input: {
    by: string;
    at: Date;
    from: { month: number; day: number; timeZone: string };
    to: { month: number; day: number; timeZone: string };
  }): Promise<void> {
    await this.writer.write({
      eventType: AuditEventType.SUPER_ADMIN_OP,
      actorId: input.by,
      actorRoles: ['PLATFORM'],
      scope: { kind: 'PLATFORM' },
      source: { channel: 'ADMIN' },
      target: { objectType: 'ACADEMIC_YEAR_BOUNDARY', objectId: 'platform-boundary' },
      oldValues: { ...input.from },
      newValues: { ...input.to },
      outcome: AuditOutcome.SUCCESS,
      requestId: randomUUID(),
      occurredAt: input.at.toISOString(),
    });
  }
}

/** 通知事实背书配置通知（NTF-002/NTF-005；IFC-TX-002 同事务 + NTF-003 幂等） */
export class NotificationFactBackedConfigNotification implements ConfigNotificationPort {
  constructor(
    private readonly createFact: CreateNotificationFactCommand,
    private readonly facts: NotificationRepository,
  ) {}

  async notifyPolicyChange(input: {
    scope: 'PLATFORM' | 'CLUB';
    clubId: string | null;
    key: PolicyKey;
    oldValue: number;
    newValue: number;
    changedBy: string;
    effectiveAt: Date;
  }): Promise<void> {
    const scopeLabel = input.clubId ?? input.scope;
    const logicalEventId = `cfg-policy-${input.scope}-${scopeLabel}-${input.key}-${input.effectiveAt.getTime()}`;
    await this.emitIfNew(logicalEventId, {
      logicalEventId,
      sourceObjectId: `${input.scope}:${scopeLabel}:${input.key}`,
      sourceObjectVersion: 1,
      sourceCommandId: randomUUID(),
      eventType: 'system',
      eventTime: input.effectiveAt.toISOString(),
      summary: `权益策略 ${input.scope} ${scopeLabel} ${input.key} 默认值变更为 ${input.newValue}`,
      targetObjectRef: null,
      scope: { type: input.scope, clubId: input.clubId },
    });
  }

  async notifyConfigPublished(input: {
    rootId: string;
    kind: ConfigKind;
    versionNumber: number;
    publishedBy: string;
    highRisk: boolean;
  }): Promise<void> {
    const logicalEventId = `cfg-published-${input.rootId}-v${input.versionNumber}`;
    await this.emitIfNew(logicalEventId, {
      logicalEventId,
      sourceObjectId: input.rootId,
      sourceObjectVersion: input.versionNumber,
      sourceCommandId: randomUUID(),
      eventType: 'system',
      eventTime: new Date().toISOString(),
      summary: `配置版本发布 ${input.rootId} v${input.versionNumber}${
        input.highRisk ? ' 高风险' : ''
      }`,
      targetObjectRef: null,
      scope: { type: 'PLATFORM', clubId: null },
    });
  }

  /**
   * 幂等发射（NTF-003）：config 事实零收件人 → fact 级 dedup_key 即 logicalEventId，
   * 预检命中即视为已持久化、静默跳过；未命中交命令同事务保存（重复键冲突兜底抛错）。
   */
  private async emitIfNew(
    logicalEventId: string,
    input: CreateNotificationFactInput,
  ): Promise<void> {
    if ((await this.facts.findFactByDedupKey(logicalEventId)) !== null) {
      return;
    }
    await this.createFact.execute(input);
  }
}
