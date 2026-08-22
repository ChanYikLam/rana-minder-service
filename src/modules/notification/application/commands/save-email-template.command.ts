/**
 * 保存邮件模板命令（NTF-005；需求发现 08「默认模板与社团 HTML 模板」）。
 *
 * 规则：
 * - 超级管理员维护平台默认模板（PLATFORM 作用域）；
 * - 社团负责人、人事管理员、部门负责人等各级管理员可在自身有权管理的
 *   业务范围内基于默认模板修改文字信息（CLUB 作用域，权限
 *   club:config:manage 或超管）；
 * - HTML 允许常见排版标签和受限行内样式，禁止脚本、表单、iframe、
 *   自动跳转、外部 JavaScript/CSS、可执行内容和危险协议——保存前
 *   强制安全校验，未通过即拒绝（IFC-ERR-011 安全限制）；
 * - 模板修改只影响后续通知；已发送通知保留发送时快照；
 * - 版本保存支持回滚。
 */

import { Inject, Injectable, Logger } from '@nestjs/common';
import type { EmailConfigActor } from './save-email-config.command';
import { EmailConfigPermissionError } from './save-email-config.command';
import type { EmailTemplateStore, PrivilegedAuditWriter } from '../../infrastructure';
import type { EmailTemplateModel } from '../../domain';
import { EMAIL_TEMPLATE_STORE, PRIVILEGED_AUDIT_WRITER } from '../../tokens';
import { validateTemplateSafety } from '../../domain';

/** 社团模板管理权限码（负责人/人事/部门负责人按业务范围；接口清单 §2） */
export const CLUB_TEMPLATE_MANAGE_PERMISSION = 'club:config:manage';

/** 保存输入 */
export interface SaveEmailTemplateInput {
  readonly scope:
    { readonly type: 'PLATFORM' } | { readonly type: 'CLUB'; readonly clubId: string };
  readonly actor: EmailConfigActor;
  readonly kind: string;
  readonly subject: string;
  readonly htmlBody: string;
}

/** 保存结果 */
export interface SaveEmailTemplateResult {
  readonly template: EmailTemplateModel;
  readonly version: number;
}

@Injectable()
export class SaveEmailTemplateCommand {
  private readonly logger = new Logger(SaveEmailTemplateCommand.name);

  constructor(
    @Inject(EMAIL_TEMPLATE_STORE)
    private readonly templateStore: EmailTemplateStore,
    @Inject(PRIVILEGED_AUDIT_WRITER)
    private readonly audit: PrivilegedAuditWriter,
  ) {}

  async execute(input: SaveEmailTemplateInput): Promise<SaveEmailTemplateResult> {
    // 平台模板仅超管；社团模板需 club:config:manage 或超管
    if (input.scope.type === 'CLUB') {
      const hasPermission = (input.actor.permissions ?? []).includes(
        CLUB_TEMPLATE_MANAGE_PERMISSION,
      );
      if (!hasPermission && !input.actor.isPlatformAdmin) {
        throw new EmailConfigPermissionError('无权管理该社团邮件模板');
      }
      // 仅要求 club:config:manage（或超管）；不得额外要求发信配置权限
      // club:email:config（NTF-005：模板管理不依赖邮件发信配置）。
    } else if (!input.actor.isPlatformAdmin) {
      throw new EmailConfigPermissionError('平台默认模板仅超级管理员可维护');
    }

    // ---- 安全校验（NTF-005.5 + NTF-008.3）：未通过即拒绝保存 ----
    const safety = validateTemplateSafety(input.subject, input.htmlBody);
    if (!safety.safe || !safety.sanitizedHtml) {
      throw new Error(
        'IFC-ERR-011 模板未通过安全校验（违规 ' +
          safety.violations.length +
          ' 处）：禁止脚本/表单/iframe/自动跳转/外链 JS/CSS/危险协议，且不得覆盖发件人身份',
      );
    }

    const scope:
      { readonly type: 'CLUB'; readonly clubId: string } | { readonly type: 'PLATFORM' } =
      input.scope.type === 'CLUB'
        ? { type: 'CLUB', clubId: input.scope.clubId }
        : { type: 'PLATFORM' };
    const auditScope = scope.type === 'CLUB' ? 'club:' + scope.clubId : 'platform';

    const saved = await this.templateStore.saveVersion(
      scope,
      input.kind as Parameters<EmailTemplateStore['saveVersion']>[1],
      input.subject,
      safety.sanitizedHtml,
      input.actor.userId,
      '保存新版本',
    );

    await this.audit.write({
      actorId: input.actor.userId,
      actorName: input.actor.displayName,
      action: 'notification.email_template.save',
      scope: auditScope,
      targetType: 'email_template',
      targetId: saved.templateId,
      reason: '保存邮件模板新版本',
      detail: { kind: input.kind, version: String(saved.activeVersion) },
      traceId: null,
      occurredAt: new Date().toISOString(),
    });

    this.logger.log('邮件模板已保存: kind=' + input.kind + ', version=' + saved.activeVersion);
    return { template: saved, version: saved.activeVersion };
  }
}
