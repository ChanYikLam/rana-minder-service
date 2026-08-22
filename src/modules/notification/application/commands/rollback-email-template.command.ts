/**
 * 回滚邮件模板命令（NTF-005.8：模板必须支持版本保存和回滚）。
 *
 * 回滚生成新版本（内容取自历史版本），保证版本链完整可审计；
 * 已发送通知保留发送时快照，不受回滚影响。
 */

import { Inject, Injectable, Logger } from '@nestjs/common';
import type { EmailConfigActor } from './save-email-config.command';
import { EmailConfigPermissionError } from './save-email-config.command';
import type { EmailTemplateStore, PrivilegedAuditWriter } from '../../infrastructure';
import type { EmailTemplateModel } from '../../domain';
import { EMAIL_TEMPLATE_STORE, PRIVILEGED_AUDIT_WRITER } from '../../tokens';

/** 回滚输入 */
export interface RollbackEmailTemplateInput {
  readonly scope:
    { readonly type: 'PLATFORM' } | { readonly type: 'CLUB'; readonly clubId: string };
  readonly actor: EmailConfigActor;
  readonly kind: string;
  /** 目标历史版本号 */
  readonly version: number;
}

@Injectable()
export class RollbackEmailTemplateCommand {
  private readonly logger = new Logger(RollbackEmailTemplateCommand.name);

  constructor(
    @Inject(EMAIL_TEMPLATE_STORE)
    private readonly templateStore: EmailTemplateStore,
    @Inject(PRIVILEGED_AUDIT_WRITER)
    private readonly audit: PrivilegedAuditWriter,
  ) {}

  async execute(input: RollbackEmailTemplateInput): Promise<EmailTemplateModel> {
    // 权限口径与保存一致
    if (input.scope.type === 'CLUB') {
      const hasPermission = (input.actor.permissions ?? []).includes('club:config:manage');
      if (!hasPermission && !input.actor.isPlatformAdmin) {
        throw new EmailConfigPermissionError('无权回滚该社团邮件模板');
      }
    } else if (!input.actor.isPlatformAdmin) {
      throw new EmailConfigPermissionError('平台默认模板仅超级管理员可维护');
    }

    const active = await this.templateStore.findActive(
      input.scope.type === 'CLUB'
        ? { type: 'CLUB', clubId: input.scope.clubId }
        : { type: 'PLATFORM' },
      input.kind as Parameters<EmailTemplateStore['findActive']>[1],
    );
    if (!active) {
      throw new Error('该作用域下不存在此类型模板，无法回滚');
    }

    const rolled = await this.templateStore.rollbackToVersion(
      active.templateId,
      input.version,
      input.actor.userId,
    );

    await this.audit.write({
      actorId: input.actor.userId,
      actorName: input.actor.displayName,
      action: 'notification.email_template.rollback',
      scope: input.scope.type === 'PLATFORM' ? 'platform' : 'club:' + input.scope.clubId,
      targetType: 'email_template',
      targetId: active.templateId,
      reason: '回滚邮件模板到版本 ' + input.version,
      detail: { kind: input.kind, newVersion: String(rolled.activeVersion) },
      traceId: null,
      occurredAt: new Date().toISOString(),
    });

    this.logger.log(
      '邮件模板已回滚: kind=' +
        input.kind +
        ', 到版本=' +
        input.version +
        ', 新版本=' +
        rolled.activeVersion,
    );
    return rolled;
  }
}
