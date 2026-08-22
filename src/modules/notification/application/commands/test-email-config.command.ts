/**
 * 测试邮件配置命令（NTF-006.7：新配置必须通过测试邮件后启用）。
 *
 * 使用已保存的候选配置（含解密后的密钥）向指定地址发送测试邮件；
 * 发送成功才置 verified=true 并记录 lastTestPassedAt；
 * 失败保持未验证并返回脱敏错误。测试结果写入特权审计。
 */

import { Inject, Injectable, Logger } from '@nestjs/common';
import type {
  EmailAdapter,
  EmailConfigStore,
  EmailSecretCipher,
  PrivilegedAuditWriter,
} from '../../infrastructure';
import {
  EMAIL_ADAPTER,
  EMAIL_CONFIG_STORE,
  EMAIL_SECRET_CIPHER,
  PRIVILEGED_AUDIT_WRITER,
} from '../../tokens';
import { PLATFORM_EMAIL_CONFIG_KEY } from './dispatch-optional-email.command';
import {
  assertCanManageEmailConfig,
  type EmailConfigActor,
  type EmailConfigScope,
} from './save-email-config.command';

/** 测试输入 */
export interface TestEmailConfigInput {
  readonly scope: EmailConfigScope;
  readonly actor: EmailConfigActor;
  /** 测试收件地址（缺省为发信账号自身） */
  readonly to?: string;
}

/** 测试结果 */
export interface TestEmailConfigResult {
  readonly ok: boolean;
  readonly verified: boolean;
  readonly sentAt: string | null;
  readonly to: string | null;
  readonly sanitizedError: string | null;
}

@Injectable()
export class TestEmailConfigCommand {
  private readonly logger = new Logger(TestEmailConfigCommand.name);

  constructor(
    @Inject(EMAIL_CONFIG_STORE)
    private readonly emailConfigs: EmailConfigStore,
    @Inject(EMAIL_SECRET_CIPHER)
    private readonly cipher: EmailSecretCipher,
    @Inject(EMAIL_ADAPTER)
    private readonly emailAdapter: EmailAdapter,
    @Inject(PRIVILEGED_AUDIT_WRITER)
    private readonly audit: PrivilegedAuditWriter,
  ) {}

  async execute(input: TestEmailConfigInput): Promise<TestEmailConfigResult> {
    assertCanManageEmailConfig(input.scope, input.actor);

    const storeKey = input.scope.type === 'CLUB' ? input.scope.clubId : PLATFORM_EMAIL_CONFIG_KEY;
    const config = await this.emailConfigs.findByClub(storeKey);
    if (!config || !config.secretCiphertext) {
      throw new Error('尚未保存邮件配置，无法发送测试邮件');
    }

    // 解密密钥仅用于本次发送，不进入日志/审计/响应
    let secret: string;
    try {
      secret = this.cipher.decrypt(config.secretCiphertext);
    } catch {
      return {
        ok: false,
        verified: false,
        sentAt: null,
        to: null,
        sanitizedError: '密钥解密失败（密文损坏或主密钥轮换），请重填密钥',
      };
    }
    if (!secret) {
      return {
        ok: false,
        verified: false,
        sentAt: null,
        to: null,
        sanitizedError: '密钥为空，请重填',
      };
    }

    const to = input.to?.trim() || config.smtpUser;
    const now = new Date().toISOString();

    try {
      const result = await this.emailAdapter.send({
        to,
        subject: '【RanaMinder】发信配置测试邮件',
        body: '<p>这是一封配置验证测试邮件。收到即表示发信账号可用。</p>',
        senderIdentity: config.fromName + ' <' + config.smtpUser + '>',
        templateVersionId: null,
        fromAddress: config.smtpUser,
        replyTo: config.smtpUser,
      });

      if (result.status === 'SENT') {
        await this.emailConfigs.save({
          ...config,
          verified: true,
          lastTestPassedAt: now,
        });
        await this.audit.write({
          actorId: input.actor.userId,
          actorName: input.actor.displayName,
          action: 'notification.email_config.test_passed',
          scope: input.scope.type === 'PLATFORM' ? 'platform' : 'club:' + storeKey,
          targetType: 'email_config',
          targetId: storeKey,
          reason: '测试邮件发送成功，配置启用',
          detail: { to },
          traceId: null,
          occurredAt: now,
        });
        this.logger.log('邮件配置测试通过: scope=' + storeKey);
        return { ok: true, verified: true, sentAt: now, to, sanitizedError: null };
      }

      // BOUNCE / TEMPORARY_FAILURE / UNCERTAIN：保持未验证
      await this.audit.write({
        actorId: input.actor.userId,
        actorName: input.actor.displayName,
        action: 'notification.email_config.test_failed',
        scope: input.scope.type === 'PLATFORM' ? 'platform' : 'club:' + storeKey,
        targetType: 'email_config',
        targetId: storeKey,
        reason: '测试邮件未成功：' + result.status,
        detail: { to },
        traceId: null,
        occurredAt: now,
      });
      return {
        ok: false,
        verified: false,
        sentAt: null,
        to,
        sanitizedError: result.sanitizedError ?? '测试邮件状态: ' + result.status,
      };
    } catch (error) {
      const message = (error as Error).message;
      this.logger.warn('邮件配置测试失败: scope=' + storeKey + ', error=' + message);
      return { ok: false, verified: false, sentAt: null, to, sanitizedError: message };
    }
  }
}
