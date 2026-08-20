/**
 * 邮件渠道适配边界接口（adapters/mail/ 实现）。
 *
 * 权威来源：src/adapters/mail/邮件适配文档.md。
 * 邮件渠道投递、结果查询与退信处理由本边界实现；投递结果不是业务或通知事实权威
 * （XCC-FAIL-007：投递失败不改变业务与通知事实，不绕过邮箱验证）。
 */

import type { ExternalResult } from '../../common/contracts/external-result';

/** 验证邮件渠道投递意图（IFC-TX-005） */
export interface VerificationEmailDispatch {
  readonly subjectId: string;
  readonly toEmail: string;
  /** 验证码链接（含验证请求标识与单次令牌）；不向日志/审计泄露明文 */
  readonly code: string;
  readonly expiresAt: Date;
  /** 渠道任务/消息标识（用于结果查询与退信关联） */
  readonly externalMessageId: string | null;
}

export interface MailChannelAdapter {
  /** 投递验证邮件并返回规范化投递结果（失败不改变业务事实） */
  sendVerificationEmail(input: VerificationEmailDispatch): Promise<ExternalResult<void>>;
}