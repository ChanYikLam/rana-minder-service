/**
 * 站内信恢复命令（NTF-001、SRS-FAIL-009、IFC-NTF-001、XCC-FAIL-009）。
 *
 * 恢复站内信投递：
 * - 关闭范围内暂停投递的事实按原事件时间升序补投，同时间按稳定
 *   逻辑事件标识排序（IFC-NTF-001）；
 * - 补投只创建/确认站内信呈现（渠道），不重复产生业务事件；
 *   同一逻辑事件＋收件人只对应一条站内信（NTF-003 去重）；
 * - 范围隔离：仅恢复被关闭范围的事实，范围外不受影响；
 * - 恢复同样写入特权审计，并保留关闭历史（active=false）。
 */

import { Inject, Injectable, Logger } from '@nestjs/common';
import type {
  InboxAdapter,
  KillSwitchRepository,
  NotificationRepository,
  PrivilegedAuditWriter,
} from '../../infrastructure';
import type { KillSwitchScope, KillSwitchStateModel } from '../../domain';
import { NotificationStateMachine } from '../../domain';
import {
  INBOX_ADAPTER,
  KILL_SWITCH_REPOSITORY,
  NOTIFICATION_REPOSITORY,
  PRIVILEGED_AUDIT_WRITER,
} from '../../tokens';

export interface ResumeKillSwitchInput {
  readonly scope: KillSwitchScope;
  readonly clubId: string | null;
  readonly operatorId: string;
  readonly operatorName: string;
}

export interface ResumeKillSwitchResult {
  readonly state: KillSwitchStateModel;
  readonly resumedFactCount: number;
}

/** 批量补投的批次大小 */
const RESUME_BATCH_SIZE = 100;

@Injectable()
export class ResumeKillSwitchCommand {
  private readonly logger = new Logger(ResumeKillSwitchCommand.name);
  private readonly stateMachine = new NotificationStateMachine();

  constructor(
    @Inject(NOTIFICATION_REPOSITORY)
    private readonly repository: NotificationRepository,
    @Inject(KILL_SWITCH_REPOSITORY)
    private readonly killSwitches: KillSwitchRepository,
    @Inject(INBOX_ADAPTER)
    private readonly inboxAdapter: InboxAdapter,
    @Inject(PRIVILEGED_AUDIT_WRITER)
    private readonly audit: PrivilegedAuditWriter,
  ) {}

  /**
   * 恢复站内信投递。
   *
   * @param input 恢复输入（范围与操作者）
   * @param now 当前时间（测试可注入）
   * @throws 范围内没有活跃关闭记录时抛错
   */
  async execute(
    input: ResumeKillSwitchInput,
    now: string = new Date().toISOString(),
  ): Promise<ResumeKillSwitchResult> {
    const active = await this.killSwitches.findByScope(input.scope, input.clubId);
    if (!active?.active) {
      throw new Error('当前范围没有活跃的站内信紧急关闭');
    }

    // 范围叠加（IFC-NTF-001）：社团级关闭之上若平台级仍关闭，则该社团暂停
    // 事实须保持暂停（由平台级关闭覆盖），不得因解除社团级关闭而补投。
    // 平台级关闭期间创建/暂停的社团事实不能被社团级恢复绕过。
    const platformStillKilled =
      input.scope === 'CLUB'
        ? Boolean((await this.killSwitches.findByScope('PLATFORM', null))?.active)
        : false;

    // 恢复只补投渠道，不重放业务（NTF-001、IFC-NTF-001）
    let resumedFactCount = 0;
    if (!platformStillKilled) {
      for (;;) {
        // 按原事件时间升序（仓储已排序），分批补投
        const facts = await this.repository.findFactsPausedByKillScope(
          input.scope,
          input.clubId,
          RESUME_BATCH_SIZE,
        );
        if (facts.length === 0) break;

        // 进度保护：整批无任何事实满足转换时终止，防止不可转换事实
        // 永久停留在查询集导致死循环（IFC-NTF-001 批次语义）
        let progressed = false;
        for (const fact of facts) {
          // 状态机：暂停投递 → 待投递 → 已投递
          const resume = this.stateMachine.evaluate({
            type: 'RESUME_INBOX',
            currentStatus: fact.status,
          });
          if (!resume.allowed) continue;
          const deliver = this.stateMachine.evaluate({
            type: 'DELIVER_INBOX',
            currentStatus: 'CREATED_PENDING_DELIVERY',
          });
          if (!deliver.allowed) continue;

          try {
            // 按收件人快照创建/确认唯一呈现（NTF-003 逻辑事件＋收件人去重）
            const snapshots = await this.repository.findSnapshotsByFactId(fact.factId);
            for (const snapshot of snapshots) {
              await this.inboxAdapter.createOrConfirmPresentation(fact, snapshot);
            }

            await this.repository.updateFactStatus(fact.factId, 'DELIVERED', fact.version);
            resumedFactCount += 1;
            progressed = true;
          } catch (error) {
            // 乐观锁版本冲突：该事实可能正被并发投递，跳过并继续（IFC-ERR-008），
            // 不让单个冲突中断整批补投，确保恢复命令能完成并落库恢复状态。
            this.logger.warn(
              `补投失败（可能并发变更，跳过）: factId=${fact.factId}, error=${(error as Error).message}`,
            );
          }
        }
        if (!progressed) break;
      }
    }

    // 特权审计（恢复也属特权操作）
    const auditRef = await this.audit.write({
      actorId: input.operatorId,
      actorName: input.operatorName,
      action: 'notification.kill_switch.resume',
      scope: input.scope === 'PLATFORM' ? 'platform' : `club:${input.clubId}`,
      targetType: 'notification_inbox',
      targetId: input.scope === 'PLATFORM' ? 'platform' : (input.clubId as string),
      reason: active.reason,
      detail: {
        stoppedAt: active.stoppedAt as string,
        expectedRecoveryAt: active.expectedRecoveryAt as string,
        resumedCount: String(resumedFactCount),
      },
      traceId: null,
      occurredAt: now,
    });

    // 保留关闭历史：active=false，stoppedAt 保持首次值（清单 15.9 幂等语义）
    const closed: KillSwitchStateModel = {
      ...active,
      active: false,
      auditRef,
      version: active.version + 1,
      updatedAt: now,
    };
    await this.killSwitches.save(closed);

    this.logger.log(
      `站内信恢复完成: scope=${input.scope}, clubId=${input.clubId ?? 'platform'}, ` +
        `补投通知=${resumedFactCount} 条, 审计=${auditRef}`,
    );
    return { state: closed, resumedFactCount };
  }
}
