/**
 * 永久失败标记命令（NTF-007、SRS-SM-NTF-001 转换 9）。
 *
 * 明确退信或连续失败 24 小时后进入永久失败并保留投递证据；
 * 停止重试后必须：
 * - 通过站内信提示收件用户（邮件未送达，以站内信为权威记录）；
 * - 通知相应管理员（特权审计条目，管理员可读）。
 * 邮件失败不回滚业务（NTF-007）；每个任务只进入一次永久失败；
 * 人工重发新建尝试（NTF-007）。
 */

import { Inject, Injectable, Logger } from '@nestjs/common';
import type {
  ChannelDeliveryAttemptRepository,
  InboxAdapter,
  NotificationRepository,
  PrivilegedAuditWriter,
} from '../../infrastructure';
import { NotificationStateMachine } from '../../domain';
import {
  CHANNEL_DELIVERY_ATTEMPT_REPOSITORY,
  INBOX_ADAPTER,
  NOTIFICATION_REPOSITORY,
  PRIVILEGED_AUDIT_WRITER,
} from '../../tokens';

@Injectable()
export class MarkPermanentFailureCommand {
  private readonly logger = new Logger(MarkPermanentFailureCommand.name);
  private readonly stateMachine = new NotificationStateMachine();

  constructor(
    @Inject(CHANNEL_DELIVERY_ATTEMPT_REPOSITORY)
    private readonly attemptRepository: ChannelDeliveryAttemptRepository,
    @Inject(NOTIFICATION_REPOSITORY)
    private readonly repository: NotificationRepository,
    @Inject(INBOX_ADAPTER)
    private readonly inboxAdapter: InboxAdapter,
    @Inject(PRIVILEGED_AUDIT_WRITER)
    private readonly audit: PrivilegedAuditWriter,
  ) {}

  /**
   * 标记永久失败并履行 NTF-007 提示义务。
   * 幂等：重复调用不产生重复站内信提示（去重键保护）。
   */
  async execute(attemptId: string): Promise<void> {
    const attempt = await this.attemptRepository.findAttemptById(attemptId);
    if (!attempt) {
      this.logger.warn('无可标记为永久失败的尝试: ' + attemptId);
      return;
    }

    const transition = this.stateMachine.evaluate({
      type: 'MARK_PERMANENT_FAILURE',
      currentStatus: 'CREATED_PENDING_DELIVERY',
      currentChannelStatus: attempt.status,
      channel: attempt.channel,
    });

    if (!transition.allowed) {
      this.logger.log('尝试 ' + attemptId + ' 不可标记永久失败: ' + transition.reason);
      return;
    }

    await this.attemptRepository.updateAttempt(attemptId, {
      status: 'PERMANENT_FAILURE',
      completedAt: new Date().toISOString(),
    });
    this.logger.log('投递尝试标记永久失败: attemptId=' + attemptId);

    // ---- NTF-007：邮件渠道永久失败后提示用户＋通知管理员 ----
    if (attempt.channel === 'EMAIL') {
      await this.notifyUserAndAdmins(attempt.attemptId, attempt.factId, attempt.responseCategory);
    }
  }

  /** 站内信提示用户（权威渠道兜底）＋特权审计通知管理员 */
  private async notifyUserAndAdmins(
    attemptId: string,
    factId: string,
    responseCategory: string | null,
  ): Promise<void> {
    const fact = await this.repository.findFactById(factId);
    if (!fact) {
      this.logger.warn('永久失败关联的通知事实不存在: ' + factId);
      return;
    }
    const snapshots = await this.repository.findSnapshotsByFactId(factId);

    // 站内信提示：为每位收件人创建系统事实＋唯一呈现（去重键幂等）
    for (const snapshot of snapshots) {
      try {
        const now = new Date().toISOString();
        const noticeDedupKey = 'email-permfail\u0000' + attemptId + '\u0000' + snapshot.recipientId;
        const { fact: noticeFact, snapshots: noticeSnapshots } =
          await this.repository.saveFactWithSnapshots(
            {
              logicalEventId: noticeDedupKey,
              sourceObjectId: fact.sourceObjectId,
              sourceObjectVersion: fact.sourceObjectVersion,
              sourceCommandId: fact.sourceCommandId,
              eventType: 'system',
              eventTime: now,
              // 最少信息：只说明邮件未送达与站内信为权威渠道，不含失败细节
              summary: '你的其中一封邮件通知未能送达，本站内信为该通知的权威记录。',
              targetObjectRef: fact.targetObjectRef,
              deadlineAt: null,
              scope: fact.scope,
            },
            [
              {
                ...snapshot,
                snapshotId: '',
                factId: '',
                dedupKey: noticeDedupKey,
                createdAt: now,
                reason: '本人（邮件永久失败站内信提示）',
              },
            ],
          );
        for (const savedSnapshot of noticeSnapshots) {
          await this.inboxAdapter.createOrConfirmPresentation(noticeFact, savedSnapshot);
        }
      } catch (error) {
        const message = (error as Error).message;
        if (message.includes('去重键冲突')) {
          // 已提示过：幂等通过
          continue;
        }
        throw error;
      }
    }

    // 管理员通知：特权审计条目（管理员可读；不含密钥/完整错误原文）
    await this.audit.write({
      actorId: 'system',
      actorName: '系统',
      action: 'notification.email.permanent_failure',
      scope:
        fact.scope.type === 'CLUB' ? 'club:' + (fact.scope.clubId ?? '') : String(fact.scope.type),
      targetType: 'channel_delivery_attempt',
      targetId: attemptId,
      reason:
        '邮件投递永久失败（' + (responseCategory ?? 'UNKNOWN') + '），已停止重试并以站内信提示用户',
      detail: {
        factId,
        responseCategory: responseCategory ?? 'UNKNOWN',
      },
      traceId: null,
      occurredAt: new Date().toISOString(),
    });
  }
}
