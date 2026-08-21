/**
 * 邮件渠道适配桩（adapters/mail/；未连接态失败关闭）。
 *
 * 投递失败不改变业务与通知事实，不绕过邮箱验证（XCC-FAIL-007）；
 * 领域层据此按发信能力不可用拒绝签发（IFC-ERR-012 语义）。
 */

import { randomUUID } from 'node:crypto';
import type { MailChannelAdapter, VerificationEmailDispatch } from './mail-channel-adapter';
import { externalFailure, type ExternalResult } from '../../common/contracts/external-result';

export class NotWiredMailChannelAdapter implements MailChannelAdapter {
  async sendVerificationEmail(_input: VerificationEmailDispatch): Promise<ExternalResult<void>> {
    return externalFailure(
      'UNAVAILABLE',
      {
        code: 'MAIL-NOT-WIRED',
        message: '邮件渠道适配未连接（首版桩）',
        retryable: true,
        rawStatusCode: null,
      },
      randomUUID(),
      new Date(),
    );
  }
}
