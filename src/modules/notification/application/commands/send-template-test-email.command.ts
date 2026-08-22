/**
 * 模板测试邮件命令（NTF-005.8：模板必须支持测试邮件）。
 *
 * 使用草稿或当前活跃模板渲染白名单样例变量后发送测试邮件；
 * 测试邮件不是通知投递：不创建渠道尝试、不影响业务与站内信。
 * 草稿未通过安全校验时拒绝发送并返回违规项。
 */

import { Inject, Injectable, Logger } from '@nestjs/common';
import type { EmailAdapter } from '../../infrastructure';
import { EMAIL_ADAPTER } from '../../tokens';
import { EmailTemplateResolver } from '../services/email-template-resolver';

/** 测试输入 */
export interface SendTemplateTestEmailInput {
  readonly kind: string;
  readonly clubId: string | null;
  /** 草稿（提供时预览校验草稿而非活跃模板） */
  readonly draftSubject?: string | null;
  readonly draftHtmlBody?: string | null;
  /** 测试收件地址（通常为操作者本人邮箱） */
  readonly to: string;
  /** 实际发信账号与展示名（来自已验证配置；由调用方解析后传入） */
  readonly fromAddress: string;
  readonly fromDisplayName: string;
}

/** 测试结果 */
export interface SendTemplateTestEmailResult {
  readonly ok: boolean;
  readonly sanitizedError: string | null;
  /** 草稿安全校验违规（拒绝发送时返回） */
  readonly violations: readonly string[];
}

/** 模板测试样例变量（白名单；不含任何真实学生数据） */
export const TEMPLATE_SAMPLE_VARIABLES: Record<string, string> = {
  studentName: '（学生姓名）',
  clubName: '（社团名称）',
  activityName: '（活动名称）',
  departmentName: '（部门名称）',
  positionName: '（职位名称）',
  interviewTime: '（面试时间）',
  interviewPlace: '（面试地点）',
  conclusion: '（结论）',
  deadline: '（截止时间）',
  noticeDate: '（通知日期）',
  platformName: 'RanaMinder 平台',
};

@Injectable()
export class SendTemplateTestEmailCommand {
  private readonly logger = new Logger(SendTemplateTestEmailCommand.name);

  constructor(
    private readonly templateResolver: EmailTemplateResolver,
    @Inject(EMAIL_ADAPTER)
    private readonly emailAdapter: EmailAdapter,
  ) {}

  async execute(input: SendTemplateTestEmailInput): Promise<SendTemplateTestEmailResult> {
    if (!input.to) {
      return { ok: false, sanitizedError: '测试收件地址不能为空', violations: [] };
    }

    const preview = await this.templateResolver.preview({
      kind: input.kind as Parameters<EmailTemplateResolver['preview']>[0]['kind'],
      clubId: input.clubId,
      draftSubject: input.draftSubject ?? null,
      draftHtmlBody: input.draftHtmlBody ?? null,
      variables: TEMPLATE_SAMPLE_VARIABLES,
    });

    if (!preview.ok) {
      return {
        ok: false,
        sanitizedError: '模板未通过安全校验，拒绝发送',
        violations: preview.violations,
      };
    }

    try {
      const result = await this.emailAdapter.send({
        to: input.to,
        subject: '【测试】' + preview.subject,
        body: preview.htmlBody,
        senderIdentity: input.fromDisplayName + ' <' + input.fromAddress + '>',
        templateVersionId: null,
        // 回复地址固定为实际发信账号（NTF-009）
        fromAddress: input.fromAddress,
        replyTo: input.fromAddress,
      });
      if (result.status === 'SENT') {
        return { ok: true, sanitizedError: null, violations: [] };
      }
      return {
        ok: false,
        sanitizedError: result.sanitizedError ?? '测试邮件状态: ' + result.status,
        violations: [],
      };
    } catch (error) {
      return { ok: false, sanitizedError: (error as Error).message, violations: [] };
    }
  }
}
