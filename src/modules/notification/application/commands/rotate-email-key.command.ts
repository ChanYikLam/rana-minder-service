/**
 * 轮换发信密钥命令（NTF-006.7：密钥只能重填或轮换，不明文回显）。
 *
 * 轮换语义：
 * - 立即失效当前密钥（清除密文与指纹）并将 verified 置 false；
 * - 轮换后必须重填新密钥并通过测试邮件才能重新启用（NTF-006.7）；
 * - 历史投递保留原身份（渠道尝试的 senderIdentity 快照，NTF-009.5）；
 * - 轮换动作写入特权审计。
 */

import { Inject, Injectable, Logger } from '@nestjs/common';
import type { EmailConfigStore, PrivilegedAuditWriter } from '../../infrastructure';
import { EMAIL_CONFIG_STORE, PRIVILEGED_AUDIT_WRITER } from '../../tokens';
import { PLATFORM_EMAIL_CONFIG_KEY } from './dispatch-optional-email.command';
import {
  assertCanManageEmailConfig,
  type EmailConfigActor,
  type EmailConfigScope,
} from './save-email-config.command';

/** 轮换结果 */
export interface RotateEmailKeyResult {
  readonly rotated: boolean;
  readonly rotatedAt: string;
  readonly verified: false;
}

@Injectable()
export class RotateEmailKeyCommand {
  private readonly logger = new Logger(RotateEmailKeyCommand.name);

  constructor(
    @Inject(EMAIL_CONFIG_STORE)
    private readonly emailConfigs: EmailConfigStore,
    @Inject(PRIVILEGED_AUDIT_WRITER)
    private readonly audit: PrivilegedAuditWriter,
  ) {}

  async execute(input: {
    readonly scope: EmailConfigScope;
    readonly actor: EmailConfigActor;
  }): Promise<RotateEmailKeyResult> {
    assertCanManageEmailConfig(input.scope, input.actor);

    const storeKey = input.scope.type === 'CLUB' ? input.scope.clubId : PLATFORM_EMAIL_CONFIG_KEY;
    const existing = await this.emailConfigs.findByClub(storeKey);
    const now = new Date().toISOString();

    if (existing) {
      await this.emailConfigs.save({
        ...existing,
        // 密钥立即失效：清除密文与指纹，必须重填
        secretCiphertext: null,
        secretFingerprint: null,
        verified: false,
        lastTestPassedAt: null,
        keyRotatedAt: now,
      });
    }

    await this.audit.write({
      actorId: input.actor.userId,
      actorName: input.actor.displayName,
      action: 'notification.email_config.rotate_key',
      scope: input.scope.type === 'PLATFORM' ? 'platform' : 'club:' + storeKey,
      targetType: 'email_config',
      targetId: storeKey,
      reason: '密钥轮换：旧密钥失效，需重填并通过测试邮件后启用',
      detail: {},
      traceId: null,
      occurredAt: now,
    });

    this.logger.log('发信密钥已轮换（旧密钥失效）: scope=' + storeKey);
    return { rotated: true, rotatedAt: now, verified: false };
  }
}
