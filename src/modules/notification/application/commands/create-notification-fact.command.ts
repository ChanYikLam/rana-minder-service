/**
 * 创建通知事实命令（NTF-001、NTF-002、IFC-TX-002）。
 *
 * 由各领域命令在同事务内调用。通知事实、收件人快照与权益业务结果
 * 在同一数据库事务原子保存；保存失败则原业务整体回滚。
 *
 * 去重（NTF-003）：同一逻辑事件＋收件人唯一，去重键统一由
 * `buildDedupKey(logicalEventId, recipientId)` 生成（DATA-NTF-001）；
 * 已存在的逻辑事件＋收件人跳过，不重复创建通知事实。
 *
 * 站内信紧急关闭期间（SRS-FAIL-009）：通知事实与收件人快照仍保存，
 * 新事实标记为暂停投递；权益业务可继续。
 *
 * 此命令是"供各领域命令同事务调用的事务能力"，不是独立公开命令。
 */

import { Inject, Injectable, Logger } from '@nestjs/common';
import type {
  CreateNotificationFactInput,
  NotificationFactStatus,
  RecipientSnapshot,
} from '../../domain';
import {
  NotificationStateMachine,
  buildDedupKey,
  validateNotificationFactInput,
} from '../../domain';
import type { KillSwitchRepository, NotificationRepository } from '../../infrastructure';
import type { RecipientResolver } from '../../domain';
import { KILL_SWITCH_REPOSITORY, NOTIFICATION_REPOSITORY, RECIPIENT_RESOLVER } from '../../tokens';

export interface CreateNotificationFactResult {
  readonly factId: string;
  readonly snapshotCount: number;
  /** 是否因逻辑事件＋收件人去重而跳过创建（NTF-003） */
  readonly deduplicated: boolean;
}

@Injectable()
export class CreateNotificationFactCommand {
  private readonly logger = new Logger(CreateNotificationFactCommand.name);
  private readonly stateMachine = new NotificationStateMachine();

  constructor(
    @Inject(NOTIFICATION_REPOSITORY)
    private readonly repository: NotificationRepository,
    @Inject(RECIPIENT_RESOLVER)
    private readonly resolver: RecipientResolver,
    @Inject(KILL_SWITCH_REPOSITORY)
    private readonly killSwitches: KillSwitchRepository,
  ) {}

  /**
   * 在同事务内创建通知事实和收件人快照。
   * 此方法应在调用方数据库事务内执行。
   *
   * @param input 通知事实创建输入
   * @returns 创建结果
   * @throws 保存失败时抛出异常，调用方事务整体回滚（NTF-001、SRS-FAIL-008）
   */
  async execute(input: CreateNotificationFactInput): Promise<CreateNotificationFactResult> {
    // 校验输入合法性
    const validationError = validateNotificationFactInput(input);
    if (validationError) {
      throw new Error(`通知事实输入校验失败: ${validationError}`);
    }

    // 解析收件人（NTF-002：收件人名单在业务事件发生时形成快照）
    const resolveResult = this.resolver.resolve({
      logicalEventId: input.logicalEventId,
      eventType: input.eventType,
      sourceObjectId: input.sourceObjectId,
      scope: { type: input.scope.type, clubId: input.scope.clubId },
      operatorId: input.sourceCommandId,
      targetStudentId: input.sourceObjectId,
    });

    // 构建收件人快照；去重键统一为 逻辑事件＋收件人（DATA-NTF-001、NTF-003）
    const snapshots: RecipientSnapshot[] = resolveResult.recipients.map((r) => ({
      snapshotId: '', // 由仓储生成
      factId: '', // 由仓储生成
      recipientId: r.recipientId,
      reason: r.reason,
      scope: r.scope,
      dedupKey: buildDedupKey(input.logicalEventId, r.recipientId),
      createdAt: '', // 由仓储生成
    }));

    if (snapshots.length === 0) {
      this.logger.warn(`通知事实 ${input.logicalEventId} 解析出的收件人列表为空`);
    }

    // 去重检查（NTF-003）：同一逻辑事件＋收件人已存在则跳过该收件人
    const uniqueSnapshots: RecipientSnapshot[] = [];
    for (const snapshot of snapshots) {
      const existing = await this.repository.findFactByDedupKey(snapshot.dedupKey);
      if (existing) {
        this.logger.log(
          `逻辑事件＋收件人已存在，跳过: dedupKey=${snapshot.dedupKey}, factId=${existing.factId}`,
        );
        continue;
      }
      uniqueSnapshots.push(snapshot);
    }
    if (snapshots.length > 0 && uniqueSnapshots.length === 0) {
      this.logger.log(`通知事实去重跳过: logicalEventId=${input.logicalEventId}`);
      return { factId: '', snapshotCount: 0, deduplicated: true };
    }

    // 站内信紧急关闭期间：新事实标记为暂停投递，事实与快照仍保存（SRS-FAIL-009）
    const initialStatus = await this.resolveInitialStatus(input);

    // 原子保存通知事实＋收件人快照（IFC-TX-002 边界 2）
    // 保存失败则抛出异常，由调用方事务整体回滚
    const result = await this.repository.saveFactWithSnapshots(
      { ...input, initialStatus },
      uniqueSnapshots,
    );

    this.logger.log(
      `通知事实创建成功: factId=${result.fact.factId}, ` +
        `收件人数=${result.snapshots.length}, ` +
        `事件类型=${input.eventType}, 初始状态=${initialStatus}`,
    );

    return {
      factId: result.fact.factId,
      snapshotCount: result.snapshots.length,
      deduplicated: false,
    };
  }

  /**
   * 按紧急关闭范围计算初始投递状态（状态机转换 1）：
   * 平台关闭或所属社团关闭时 → 暂停投递。
   */
  private async resolveInitialStatus(
    input: CreateNotificationFactInput,
  ): Promise<'CREATED_PENDING_DELIVERY' | 'CREATED_PAUSED_DELIVERY'> {
    const platformKill = await this.killSwitches.findByScope('PLATFORM', null);
    const clubKill =
      input.scope.type === 'CLUB' && input.scope.clubId
        ? await this.killSwitches.findByScope('CLUB', input.scope.clubId)
        : null;

    const inboxKilled = Boolean(platformKill?.active) || Boolean(clubKill?.active);
    const transition = this.stateMachine.evaluate({
      type: 'CREATE_NOTIFICATION_FACT',
      currentStatus: 'NEW' as NotificationFactStatus,
      inboxKilled,
    });
    return (transition.newStatus ?? 'CREATED_PENDING_DELIVERY') as
      'CREATED_PENDING_DELIVERY' | 'CREATED_PAUSED_DELIVERY';
  }
}
