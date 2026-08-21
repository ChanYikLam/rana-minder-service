/**
 * 验证邮件渠道意图（infrastructure；IFC-TX-005；mail 适配边界）。
 *
 * 登记渠道投递意图并委托 MailChannelAdapter 投递；投递失败不改变业务与通知事实，
 * 不绕过邮箱验证（XCC-FAIL-007）。令牌只经调用方回传，不写入日志/审计。
 */

import { Logger } from '@nestjs/common';

import type { MailChannelAdapter } from '../../../adapters/mail/mail-channel-adapter';
import type { MailVerificationPort } from '../application/ports/mail-verification.port';

export class MailVerificationChannel implements MailVerificationPort {
  private readonly logger = new Logger(MailVerificationChannel.name);

  constructor(private readonly mail: MailChannelAdapter) {}

  async sendVerificationEmail(input: {
    subjectId: string;
    toEmail: string;
    token: string;
    expiresAt: Date;
  }): Promise<void> {
    // 投递失败不改变业务与通知事实（XCC-FAIL-007，不绕过邮箱验证），因此不抛错；
    // 但须记录投递结果，避免接入真实 mail 渠道后投递失败被静默吞掉。
    const result = await this.mail.sendVerificationEmail({
      subjectId: input.subjectId,
      toEmail: input.toEmail,
      code: input.token,
      expiresAt: input.expiresAt,
      externalMessageId: null,
    });
    if (result.status !== 'SUCCESS') {
      const message = result.error ? result.error.message : '未知投递错误';
      this.logger.warn(
        `验证邮件投递失败（${result.status}）：${message}，attempt=${result.attemptId}`,
      );
    }
  }
}
