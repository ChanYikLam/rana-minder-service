/**
 * 可选邮件渠道编排命令（NTF-004 至 NTF-007；4.3.3 核心）。
 *
 * 编排规则（产品行为已冻结，需求发现 08）：
 * - 站内信是权威通知记录：无论是否选择邮件，必须先建站内信（NTF-004.3/4）；
 * - 邮件是可选附加渠道：默认开启（允许邮件的学生权益通知），可被
 *   平台停用（超管统一停用某类）、社团策略（按活动或类型关闭）、
 *   本次人工取消、用户偏好（学生可关普通业务邮件）、邮箱未验证、
 *   发信账号无效逐层关闭；
 * - 社团没有有效发信密钥时只能发站内信，不能借用其他社团密钥（NTF-006）；
 * - 邮件失败不回滚业务，也不影响已创建的站内信（NTF-007）；
 * - 邮件内容经模板管道渲染（社团自定义安全模板 → 平台默认模板回退，
 *   NTF-005），只携带收件学生本人必要信息。
 */

import { Inject, Injectable, Logger } from '@nestjs/common';
import type {
  ClubEmailPolicyStore,
  EmailConfigStore,
  InboxAdapter,
  NotificationPreferencesStore,
  NotificationRepository,
  PlatformEmailSuspensionStore,
} from '../../infrastructure';
import type {
  ChannelDeliveryAttemptModel,
  NotificationFactModel,
  RecipientSnapshot,
} from '../../domain';
import { resolveClubEmailEnabled, resolveUserEmailEnabled } from '../../domain';
import { CreateEmailAttemptCommand } from './create-email-attempt.command';
import { EmailTemplateResolver } from '../services/email-template-resolver';
import {
  CLUB_EMAIL_POLICY_STORE,
  EMAIL_CONFIG_STORE,
  INBOX_ADAPTER,
  NOTIFICATION_REPOSITORY,
  PLATFORM_EMAIL_SUSPENSION_STORE,
  PREFERENCES_STORE,
} from '../../tokens';

/** 平台级发信配置在 EmailConfigStore 中的保留键 */
export const PLATFORM_EMAIL_CONFIG_KEY = '__platform__';

/** 编排输入 */
export interface DispatchOptionalEmailInput {
  readonly factId: string;
  /** 收件人标识（本次只编排该收件人；多收件人由调用方逐个调用） */
  readonly recipientId: string;
  /**
   * 收件人当前已验证邮箱与验证状态（身份模块实时读取后传入；
   * 未验证邮箱 → 只发站内信，NTF-004）。
   */
  readonly recipientEmail: string | null;
  readonly emailVerified: boolean;
  /** 活动标识（活动粒度社团策略；自动通知使用活动配置） */
  readonly activityId?: string | null;
  /**
   * 本次人工发布取消邮件（NTF-004：人工发布时有权操作者可取消本次可选邮件；
   * 自动通知不传本字段，使用活动配置）。
   */
  readonly skipEmailThisTime?: boolean;
  /** 模板渲染变量（白名单结构，见 TemplateVariables） */
  readonly templateVariables?: Record<string, string>;
}

/** 编排结果 */
export interface DispatchOptionalEmailResult {
  readonly fact: NotificationFactModel | null;
  /** 站内信呈现标识（权威记录；紧急关闭暂停期间也为 null——事实仍保存） */
  readonly inboxPresentationId: string | null;
  /** 邮件投递尝试（null 表示未创建邮件任务） */
  readonly emailAttempt: ChannelDeliveryAttemptModel | null;
  /** 未创建邮件任务的原因（审计与排查用；不含敏感信息） */
  readonly emailSkipReason: string | null;
}

/** 学生权益事件目录：8 类普通业务通知均允许邮件且默认开启（NTF-004.1） */
const EMAIL_ALLOWED_EVENT_KINDS = new Set([
  'application',
  'interview',
  'invitation',
  'conclusion',
  'system',
  'member',
  'transition',
  'correction',
]);

@Injectable()
export class DispatchOptionalEmailCommand {
  private readonly logger = new Logger(DispatchOptionalEmailCommand.name);

  constructor(
    @Inject(NOTIFICATION_REPOSITORY)
    private readonly repository: NotificationRepository,
    @Inject(INBOX_ADAPTER)
    private readonly inboxAdapter: InboxAdapter,
    @Inject(EMAIL_CONFIG_STORE)
    private readonly emailConfigs: EmailConfigStore,
    @Inject(CLUB_EMAIL_POLICY_STORE)
    private readonly clubPolicies: ClubEmailPolicyStore,
    @Inject(PLATFORM_EMAIL_SUSPENSION_STORE)
    private readonly platformSuspension: PlatformEmailSuspensionStore,
    @Inject(PREFERENCES_STORE)
    private readonly userPreferences: NotificationPreferencesStore,
    private readonly createEmailAttempt: CreateEmailAttemptCommand,
    private readonly templateResolver: EmailTemplateResolver,
  ) {}

  async execute(input: DispatchOptionalEmailInput): Promise<DispatchOptionalEmailResult> {
    const fact = await this.repository.findFactById(input.factId);
    if (!fact) {
      return {
        fact: null,
        inboxPresentationId: null,
        emailAttempt: null,
        emailSkipReason: '通知事实不存在',
      };
    }

    const snapshots = await this.repository.findSnapshotsByFactId(input.factId);
    const snapshot = snapshots.find((s) => s.recipientId === input.recipientId) ?? null;

    // ---- 第一步：站内信（权威渠道，必须创建；NTF-004.3/4）----
    let inboxPresentationId: string | null = null;
    if (snapshot) {
      const presentation = await this.inboxAdapter.createOrConfirmPresentation(fact, snapshot);
      inboxPresentationId = presentation.presentationId;
    }

    // ---- 第二步：邮件资格链评估（任一层关闭即只发站内信）----
    const skip = await this.evaluateEmailSkip(fact, input);
    if (skip) {
      this.logger.log(
        '邮件未创建: factId=' +
          input.factId +
          ', recipientId=' +
          input.recipientId +
          ', reason=' +
          skip,
      );
      return { fact, inboxPresentationId, emailAttempt: null, emailSkipReason: skip };
    }

    // ---- 第三步：解析发件身份（NTF-006/008：社团独立配置，不能借用）----
    const sender = await this.resolveSenderAccount(fact);
    if (!sender.valid) {
      return { fact, inboxPresentationId, emailAttempt: null, emailSkipReason: sender.reason };
    }

    // ---- 第四步：模板渲染（NTF-005：社团自定义安全模板 → 平台默认回退）----
    const rendered = await this.templateResolver.renderForFact({
      kind: fact.eventType,
      clubId: fact.scope.type === 'CLUB' ? fact.scope.clubId : null,
      variables: {
        platformName: sender.platformDisplayName,
        ...(input.templateVariables ?? {}),
      },
    });

    // ---- 第五步：创建邮件尝试并发送（失败不回滚业务/站内信，NTF-007）----
    const attempt = await this.createEmailAttempt.execute({
      factId: input.factId,
      recipientId: input.recipientId,
      recipientEmail: input.recipientEmail as string,
      eventAllowsEmail: true,
      configClosedEmail: false,
      userUnsubscribed: false,
      emailVerified: true,
      senderAccountValid: true,
      eventType: fact.eventType,
      emailSubject: rendered.subject,
      emailBody: rendered.htmlBody,
      senderDisplayName: sender.displayName,
      senderFromAddress: sender.fromAddress,
    });

    return {
      fact,
      inboxPresentationId,
      emailAttempt: attempt,
      emailSkipReason: attempt ? null : '邮件尝试创建失败',
    };
  }

  /** 邮件资格链：返回 null 表示可以发邮件，否则返回跳过原因 */
  private async evaluateEmailSkip(
    fact: NotificationFactModel,
    input: DispatchOptionalEmailInput,
  ): Promise<string | null> {
    // 1) 事件目录：只有允许邮件的学生权益事件才可能发邮件（NTF-004）
    if (!EMAIL_ALLOWED_EVENT_KINDS.has(fact.eventType)) {
      return '事件类型不允许邮件投递';
    }
    // 2) 本次人工取消（NTF-004：人工发布时有权操作者可取消本次可选邮件）
    if (input.skipEmailThisTime) {
      return '本次发布已取消邮件';
    }
    // 3) 平台级统一停用某类邮件（NTF-004：超级管理员可统一停用某类邮件）
    const suspension = await this.platformSuspension.get();
    if (suspension[fact.eventType as keyof typeof suspension] === false) {
      return '平台已统一停用该类邮件';
    }
    // 4) 社团策略：按活动或类型关闭（NTF-004：负责人/人事可按活动或类型关闭）
    if (fact.scope.type === 'CLUB' && fact.scope.clubId) {
      const policy = await this.clubPolicies.findByClub(fact.scope.clubId);
      const enabled = resolveClubEmailEnabled(policy, fact.eventType, input.activityId ?? null);
      if (!enabled) {
        return '社团策略已关闭该活动/类型的邮件';
      }
    }
    // 5) 用户偏好：学生可关普通业务邮件（受保护类别不在偏好模型内，NTF-004）
    const prefsStored = await this.userPreferences.get(input.recipientId);
    const userEnabled = resolveUserEmailEnabled(
      (prefsStored?.preferences ?? {}) as Record<string, boolean>,
      fact.eventType,
    );
    if (!userEnabled) {
      return '用户已关闭该类普通业务邮件';
    }
    // 6) 邮箱状态：未验证邮箱只发站内信（NTF-004）
    if (!input.emailVerified || !input.recipientEmail) {
      return '邮箱未验证或缺失，只发站内信';
    }
    return null;
  }

  /**
   * 解析实际发信账号（NTF-006/008）：
   * CLUB 作用域必须用该社团自己的已验证配置；PLATFORM/JOINT 用平台配置。
   * 无有效配置 → 只能发站内信。
   */
  private async resolveSenderAccount(
    fact: NotificationFactModel,
  ): Promise<
    | { valid: true; displayName: string; fromAddress: string; platformDisplayName: string }
    | { valid: false; reason: string }
  > {
    const platformDisplayName = 'RanaMinder 平台';
    if (fact.scope.type === 'CLUB') {
      const clubId = fact.scope.clubId ?? '';
      const config = await this.emailConfigs.findByClub(clubId);
      if (!config || !config.verified || !config.secretCiphertext) {
        return { valid: false, reason: '社团无有效发信配置，只能发站内信' };
      }
      return {
        valid: true,
        displayName: config.fromName || clubId,
        fromAddress: config.smtpUser,
        platformDisplayName,
      };
    }
    const platformConfig = await this.emailConfigs.findByClub(PLATFORM_EMAIL_CONFIG_KEY);
    if (!platformConfig || !platformConfig.verified || !platformConfig.secretCiphertext) {
      return { valid: false, reason: '平台无有效发信配置，只能发站内信' };
    }
    return {
      valid: true,
      displayName: platformConfig.fromName || platformDisplayName,
      fromAddress: platformConfig.smtpUser,
      platformDisplayName,
    };
  }
}

/** 导出快照类型供测试复用 */
export type { RecipientSnapshot };
