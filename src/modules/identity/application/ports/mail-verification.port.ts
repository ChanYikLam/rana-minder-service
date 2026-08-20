/**
 * 验证邮件渠道意图端口（IFC-TX-005；mail 适配边界）。
 *
 * 只登记渠道意图（收件邮箱、验证事实引用），投递由 notification/mail 渠道执行；
 * 邮件投递失败不改变业务与通知事实，不绕过邮箱验证（XCC-FAIL-007）。
 * 不得向渠道传递令牌明文以外的任何敏感正文；令牌只经本次响应回传调用方。
 */

export interface MailVerificationPort {
  /** 登记验证邮件投递意图（24 小时有效、重发限频由调用方校验） */
  sendVerificationEmail(input: {
    subjectId: string;
    toEmail: string;
    token: string;
    expiresAt: Date;
  }): Promise<void>;
}
