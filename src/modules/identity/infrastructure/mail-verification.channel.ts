/**
 * 验证邮件渠道意图（infrastructure；IFC-TX-005；mail 适配边界）。
 *
 * 登记渠道投递意图并委托 MailChannelAdapter 投递；投递失败不改变业务与通知事实，
 * 不绕过邮箱验证（XCC-FAIL-007）。令牌只经调用方回传，不写入日志/审计。
 */

import type { MailChannelAdapter } from '../../../adapters/mail/mail-channel-adapter';
import type { MailVerificationPort } from '../application/ports/mail-verification.port';

export class MailVerificationChannel implements MailVerificationPort {
  constructor(private readonly mail: MailChannelAdapter) {}

  async sendVerificationEmail(input: {
    subjectId: string;
    toEmail: string;
    token: string;
    expiresAt: Date;
  }): Promise<void> {
    await this.mail.sendVerificationEmail({
      subjectId: input.subjectId,
      toEmail: input.toEmail,
      code: input.token,
      expiresAt: input.expiresAt,
      externalMessageId: null,
    });
  }
}
