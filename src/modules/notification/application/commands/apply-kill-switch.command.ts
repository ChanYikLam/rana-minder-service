/**
 * 站内信紧急关闭命令（NTF-001、SRS-FAIL-009、IFC-NTF-001、XCC-FAIL-009）。
 *
 * 超级管理员按全平台或指定社团紧急关闭站内信：
 * - 必须填写原因、二次确认、设置预计恢复时间，并写入特权审计；
 * - 关闭期间权益业务可继续：通知事实和收件人快照仍保存，
 *   待投递事实标记为暂停投递（状态机转换 2）；
 * - 重复关闭同范围幂等：保留首次 stoppedAt，不重复暂停；
 * - 超管鉴权由接口层守卫执行，本命令只负责业务与审计事实。
 */

import { Injectable, Logger } from '@nestjs/common';
import type {
  KillSwitchRepository,
  NotificationRepository,
  PrivilegedAuditWriter,
} from '../../infrastructure';
import type { KillSwitchCommandInput, KillSwitchStateModel } from '../../domain';
import { NotificationStateMachine, validateKillSwitchCommandInput } from '../../domain';

export interface ApplyKillSwitchResult {
  readonly state: KillSwitchStateModel;
  readonly pausedFactCount: number;
}

/** 批量暂停的批次大小 */
const PAUSE_BATCH_SIZE = 100;

@Injectable()
export class ApplyKillSwitchCommand {
  private readonly logger = new Logger(ApplyKillSwitchCommand.name);
  private readonly stateMachine = new NotificationStateMachine();

  constructor(
    private readonly repository: NotificationRepository,
    private readonly killSwitches: KillSwitchRepository,
    private readonly audit: PrivilegedAuditWriter,
  ) {}

  /**
   * 关闭站内信。
   *
   * @param input 关闭输入（原因、二次确认、预计恢复时间、操作者）
   * @param now 当前时间（测试可注入）
   */
  async execute(
    input: KillSwitchCommandInput,
    now: string = new Date().toISOString(),
  ): Promise<ApplyKillSwitchResult> {
    const validationError = validateKillSwitchCommandInput(input);
    if (validationError) {
      throw new Error(validationError);
    }
    if (input.expectedRecoveryAt && input.expectedRecoveryAt <= now) {
      throw new Error('预计恢复时间必须晚于当前时间');
    }

    // 幂等：同范围已处于关闭状态时保留首次 stoppedAt，返回现状（清单 15.9）
    const existing = await this.killSwitches.findByScope(input.scope, input.clubId);
    if (existing?.active) {
      this.logger.log(
        `站内信已在关闭状态（scope=${input.scope}, clubId=${input.clubId ?? 'platform'}），幂等返回`,
      );
      return { state: existing, pausedFactCount: 0 };
    }

    // 特权审计（需求发现 08：关闭必须写入特权审计）
    const auditRef = await this.audit.write({
      actorId: input.operatorId,
      actorName: input.operatorName,
      action: 'notification.kill_switch.apply',
      scope: input.scope === 'PLATFORM' ? 'platform' : `club:${input.clubId}`,
      targetType: 'notification_inbox',
      targetId: input.scope === 'PLATFORM' ? 'platform' : (input.clubId as string),
      reason: input.reason,
      detail: {
        expectedRecoveryAt: input.expectedRecoveryAt as string,
        confirmed: String(input.confirmed),
      },
      traceId: null,
      occurredAt: now,
    });

    // 暂停范围内所有待投递事实 → 已创建＋暂停投递（状态机转换 2）
    let pausedFactCount = 0;
    for (;;) {
      const facts = await this.repository.findFactsPendingDeliveryByKillScope(
        input.scope,
        input.clubId,
        PAUSE_BATCH_SIZE,
      );
      if (facts.length === 0) break;
      for (const fact of facts) {
        const transition = this.stateMachine.evaluate({
          type: 'KILL_INBOX',
          currentStatus: fact.status,
        });
        if (!transition.allowed) continue;
        await this.repository.updateFactStatus(
          fact.factId,
          'CREATED_PAUSED_DELIVERY',
          fact.version,
        );
        pausedFactCount += 1;
      }
    }

    const switchId = `ks-${now}-${input.scope.toLowerCase()}-${input.clubId ?? 'platform'}`;
    const state: KillSwitchStateModel = {
      switchId,
      scope: input.scope,
      clubId: input.clubId,
      active: true,
      reason: input.reason,
      operatorId: input.operatorId,
      operatorName: input.operatorName,
      stoppedAt: now,
      expectedRecoveryAt: input.expectedRecoveryAt,
      confirmed: input.confirmed,
      auditRef,
      droppedCount: pausedFactCount,
      version: 1,
      createdAt: now,
      updatedAt: now,
    };
    await this.killSwitches.save(state);

    this.logger.log(
      `站内信紧急关闭生效: scope=${input.scope}, clubId=${input.clubId ?? 'platform'}, ` +
        `暂停通知=${pausedFactCount} 条, 审计=${auditRef}`,
    );
    return { state, pausedFactCount };
  }
}
