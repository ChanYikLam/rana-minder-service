/**
 * 邮件投递命令（NTF-004 至 NTF-007、SRS-SM-NTF-001 转换 6/7）。
 *
 * 邮件是可选附加渠道。邮件资格判定：事件允许邮件、
 * 本次/活动配置未关闭、用户未退订、邮箱已验证、发信账号有效。
 * 邮件失败不回滚业务；临时失败自动重试；
 * 明确退信或连续失败 24 小时后停止重试（窗口从首次失败起算）。
 *
 * 投递尝试保存：收件人快照引用（snapshotId）、发件身份、模板版本、
 * 邮件标题/正文最少摘要快照与首次失败时间，保证重试可回溯且不产生
 * 空邮件（DATA-NTF-001、NTF-002、NTF-007）。
 */

import { Inject, Injectable, Logger } from '@nestjs/common';
import type {
  ChannelDeliveryAttemptRepository,
  EmailAdapter,
  NotificationRepository,
  TemplateSnapshotService,
} from '../../infrastructure';
import {
  type ChannelDeliveryAttemptModel,
  computeNextRetryAt,
  evaluateEmailEligibility,
  NotificationStateMachine,
} from '../../domain';
import {
  CHANNEL_DELIVERY_ATTEMPT_REPOSITORY,
  EMAIL_ADAPTER,
  NOTIFICATION_REPOSITORY,
  TEMPLATE_SNAPSHOT_SERVICE,
} from '../../tokens';

@Injectable()
export class CreateEmailAttemptCommand {
  private readonly logger = new Logger(CreateEmailAttemptCommand.name);
  private readonly stateMachine = new NotificationStateMachine();

  constructor(
    @Inject(NOTIFICATION_REPOSITORY)
    private readonly repository: NotificationRepository,
    @Inject(CHANNEL_DELIVERY_ATTEMPT_REPOSITORY)
    private readonly attemptRepository: ChannelDeliveryAttemptRepository,
    @Inject(EMAIL_ADAPTER)
    private readonly emailAdapter: EmailAdapter,
    @Inject(TEMPLATE_SNAPSHOT_SERVICE)
    private readonly templateService: TemplateSnapshotService,
  ) {}

  /**
   * 评估邮件资格并创建邮件投递任务。
   * 不具资格时不创建邮件，通知事实保持（NTF-004 至 NTF-007）。
   */
  async execute(input: {
    readonly factId: string;
    readonly recipientId: string;
    readonly recipientEmail: string;
    readonly eventAllowsEmail: boolean;
    readonly configClosedEmail: boolean;
    readonly userUnsubscribed: boolean;
    readonly emailVerified: boolean;
    readonly senderAccountValid: boolean;
    readonly eventType: string;
    /** 渲染后的邮件主题（4.3.3 模板管道；缺省回退最少摘要截断） */
    readonly emailSubject?: string;
    /** 渲染后的邮件正文（4.3.3 模板管道；缺省回退最少摘要） */
    readonly emailBody?: string;
    /** 发件人展示名（NTF-008：平台名或社团名；缺省回退作用域标识） */
    readonly senderDisplayName?: string;
    /** 实际发信账号（NTF-008/009；回复地址固定为该账号） */
    readonly senderFromAddress?: string;
  }): Promise<ChannelDeliveryAttemptModel | null> {
    const eligibility = evaluateEmailEligibility({
      eventAllowsEmail: input.eventAllowsEmail,
      configClosedEmail: input.configClosedEmail,
      userUnsubscribed: input.userUnsubscribed,
      emailVerified: input.emailVerified,
      senderAccountValid: input.senderAccountValid,
    });

    if (!eligibility.eligible) {
      this.logger.log(
        `邮件资格不满足: factId=${input.factId}, ` +
          `recipientId=${input.recipientId}, reason=${eligibility.reason}`,
      );
      return null;
    }

    const fact = await this.repository.findFactById(input.factId);
    if (!fact) {
      this.logger.warn(`通知事实不存在: ${input.factId}`);
      return null;
    }

    // 回溯收件人快照，保证投递尝试与快照的关联完整性（DATA-NTF-001）
    const snapshots = await this.repository.findSnapshotsByFactId(input.factId);
    const snapshot = snapshots.find((s) => s.recipientId === input.recipientId);
    if (!snapshot) {
      this.logger.warn(
        `收件人快照不存在: factId=${input.factId}, recipientId=${input.recipientId}`,
      );
      return null;
    }

    // 冻结模板版本（按事实作用域选模板：CLUB 命中社团模板，评审 W2）
    const templateVersionId = await this.templateService.snapshotTemplate(
      input.eventType,
      'EMAIL',
      fact.scope,
    );

    const now = new Date().toISOString();
    const attempt: ChannelDeliveryAttemptModel = {
      attemptId: `email-attempt-${input.factId}-${input.recipientId}-${Date.now()}`,
      factId: input.factId,
      snapshotId: snapshot.snapshotId,
      recipientId: input.recipientId,
      channel: 'EMAIL',
      channelMessageId: null,
      attemptNumber: 1,
      status: 'PENDING',
      targetAddress: input.recipientEmail,
      templateVersionId,
      // 发件身份快照（NTF-008）：展示名＋实际发信账号；历史投递保留原身份
      senderIdentity: input.senderDisplayName
        ? input.senderDisplayName + ' <' + (input.senderFromAddress ?? 'unknown') + '>'
        : fact.scope.type === 'CLUB'
          ? fact.scope.clubId
          : 'platform',
      // 内容快照（NTF-002 最少摘要 / NTF-005 模板渲染结果）：重试时复用，
      // 避免空邮件——空串（模板渲染为空）也回退最少摘要（NTF-002）
      emailSubject: input.emailSubject?.trim() ? input.emailSubject : fact.summary.slice(0, 100),
      emailBody: input.emailBody?.trim() ? input.emailBody : fact.summary,
      firstFailedAt: null,
      responseCategory: null,
      sanitizedError: null,
      nextRetryAt: null,
      createdAt: now,
      completedAt: null,
      version: 1,
    };

    await this.attemptRepository.saveAttempt(attempt);

    let latestAttempt: ChannelDeliveryAttemptModel = attempt;

    // 发送邮件
    try {
      const result = await this.emailAdapter.send({
        to: input.recipientEmail,
        subject: attempt.emailSubject ?? fact.summary.slice(0, 100),
        body: attempt.emailBody ?? fact.summary,
        senderIdentity: attempt.senderIdentity ?? '',
        templateVersionId,
        // 回复地址固定为实际发信账号（NTF-009）
        fromAddress: input.senderFromAddress ?? null,
        replyTo: input.senderFromAddress ?? null,
      });

      if (result.status === 'SENT') {
        latestAttempt = await this.attemptRepository.updateAttempt(attempt.attemptId, {
          status: 'DELIVERED',
          channelMessageId: result.channelMessageId,
          completedAt: new Date().toISOString(),
        });
      } else if (result.status === 'TEMPORARY_FAILURE') {
        latestAttempt = await this.failAttempt(attempt.attemptId, now, result.sanitizedError);
      } else if (result.status === 'BOUNCE') {
        latestAttempt = await this.attemptRepository.updateAttempt(attempt.attemptId, {
          status: 'PERMANENT_FAILURE',
          responseCategory: 'BOUNCE',
          sanitizedError: result.sanitizedError,
          completedAt: new Date().toISOString(),
        });
      } else {
        // UNCERTAIN：等待回读
        latestAttempt = await this.failAttempt(
          attempt.attemptId,
          now,
          '结果不确定，等待回读',
          'UNCERTAIN',
        );
      }
    } catch (error) {
      // 临时失败：进入重试（NTF-007），记录首次失败时间
      latestAttempt = await this.failAttempt(attempt.attemptId, now, (error as Error).message);
    }

    return latestAttempt;
  }

  /** 进入失败重试：记录首次失败时间并计算退避（NTF-007） */
  private async failAttempt(
    attemptId: string,
    now: string,
    sanitizedError: string | null,
    responseCategory: 'TEMPORARY_FAILURE' | 'UNCERTAIN' = 'TEMPORARY_FAILURE',
  ): Promise<ChannelDeliveryAttemptModel> {
    return this.attemptRepository.updateAttempt(attemptId, {
      status: 'FAILED_RETRY',
      firstFailedAt: now,
      responseCategory,
      sanitizedError,
      nextRetryAt: computeNextRetryAt(1, now),
    });
  }
}
