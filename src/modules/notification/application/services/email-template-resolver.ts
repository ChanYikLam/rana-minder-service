/**
 * 邮件模板解析与渲染服务（NTF-005）。
 *
 * 解析顺序（自动回退，NTF-005.6）：
 * 1. 社团自定义活跃模板——存在且通过安全校验时使用；
 * 2. 平台默认模板（超管维护）；
 * 3. 内置最小安全模板（平台模板也异常时的最终兜底）。
 *
 * 渲染只接受白名单变量并自动转义；非白名单占位符转义为惰性文本。
 */

import { Injectable } from '@nestjs/common';
import type { EmailTemplateStore } from '../../infrastructure';
import type { NotificationKind } from '../../../../common/contracts/notifications.contracts';
import {
  renderEmailTemplate,
  validateTemplateSafety,
  type TemplateRenderResult,
} from '../../domain';
import { EMAIL_TEMPLATE_STORE } from '../../tokens';
import { Inject } from '@nestjs/common';

/** 最终兜底的最小安全模板（仅当平台默认模板也不可用时） */
const LAST_RESORT_SUBJECT = '系统通知';
const LAST_RESORT_BODY = '<p>您有一条新通知，请登录平台查看。</p>';

/** 解析输入 */
export interface RenderForFactInput {
  readonly kind: NotificationKind;
  /** 社团标识（CLUB 作用域时提供） */
  readonly clubId: string | null;
  /** 白名单渲染变量 */
  readonly variables: Record<string, string>;
}

/** 解析结果 */
export interface ResolvedTemplateRender extends TemplateRenderResult {
  /** 实际使用的模板来源 */
  readonly source: 'CLUB_CUSTOM' | 'PLATFORM_DEFAULT' | 'LAST_RESORT';
  /** 是否发生了回退（社团模板失效/未通过安全校验 → 平台默认） */
  readonly fellBack: boolean;
  /** 回退原因（审计用；不含模板原始内容） */
  readonly fallbackReason: string | null;
}

@Injectable()
export class EmailTemplateResolver {
  constructor(
    @Inject(EMAIL_TEMPLATE_STORE)
    private readonly templateStore: EmailTemplateStore,
  ) {}

  /**
   * 为通知事实解析并渲染邮件内容（NTF-005）。
   * 社团自定义模板未选择、失效或未通过安全校验时，
   * 自动回退平台安全默认模板。
   */
  async renderForFact(input: RenderForFactInput): Promise<ResolvedTemplateRender> {
    // 1) 社团自定义
    if (input.clubId) {
      const clubTemplate = await this.templateStore.findActive(
        { type: 'CLUB', clubId: input.clubId },
        input.kind,
      );
      if (clubTemplate) {
        const safety = validateTemplateSafety(clubTemplate.subject, clubTemplate.htmlBody);
        if (safety.safe && safety.sanitizedHtml) {
          const rendered = renderEmailTemplate(
            clubTemplate.subject,
            safety.sanitizedHtml,
            input.variables,
          );
          return { ...rendered, source: 'CLUB_CUSTOM', fellBack: false, fallbackReason: null };
        }
        // 社团模板失效 → 回退平台默认（记录原因）
        const fallback = await this.renderPlatformDefault(input.kind, input.variables);
        return {
          ...fallback,
          fellBack: true,
          fallbackReason:
            '社团自定义模板未通过安全校验（违规 ' +
            safety.violations.length +
            ' 处），已回退平台默认模板',
        };
      }
    }
    // 2) 平台默认
    return {
      ...(await this.renderPlatformDefault(input.kind, input.variables)),
      fellBack: false,
      fallbackReason: null,
    };
  }

  private async renderPlatformDefault(
    kind: NotificationKind,
    variables: Record<string, string>,
  ): Promise<Omit<ResolvedTemplateRender, 'fellBack' | 'fallbackReason'>> {
    const platformTemplate = await this.templateStore.findActive({ type: 'PLATFORM' }, kind);
    if (platformTemplate) {
      const safety = validateTemplateSafety(platformTemplate.subject, platformTemplate.htmlBody);
      if (safety.safe && safety.sanitizedHtml) {
        return {
          ...renderEmailTemplate(platformTemplate.subject, safety.sanitizedHtml, variables),
          source: 'PLATFORM_DEFAULT',
        };
      }
    }
    // 3) 最终兜底：内置最小安全模板
    return {
      ...renderEmailTemplate(LAST_RESORT_SUBJECT, LAST_RESORT_BODY, variables),
      source: 'LAST_RESORT',
    };
  }

  /**
   * 预览渲染（NTF-005.8：支持预览）。
   * 草稿内容先过安全校验再渲染，预览即所见即所得；
   * 未通过安全校验返回 violations 而不渲染危险内容。
   */
  async preview(input: {
    kind: NotificationKind;
    clubId: string | null;
    draftSubject?: string | null;
    draftHtmlBody?: string | null;
    variables: Record<string, string>;
  }): Promise<
    | {
        ok: true;
        subject: string;
        htmlBody: string;
        ignoredVariables: readonly string[];
        source: ResolvedTemplateRender['source'];
      }
    | { ok: false; violations: readonly string[] }
  > {
    if (input.draftSubject != null || input.draftHtmlBody != null) {
      const subject = input.draftSubject ?? '';
      const body = input.draftHtmlBody ?? '';
      const safety = validateTemplateSafety(subject, body);
      if (!safety.safe || !safety.sanitizedHtml) {
        return { ok: false, violations: safety.violations };
      }
      const rendered = renderEmailTemplate(subject, safety.sanitizedHtml, input.variables);
      return { ok: true, ...rendered, source: 'CLUB_CUSTOM' };
    }
    const resolved = await this.renderForFact({
      kind: input.kind,
      clubId: input.clubId,
      variables: input.variables,
    });
    return {
      ok: true,
      subject: resolved.subject,
      htmlBody: resolved.htmlBody,
      ignoredVariables: resolved.ignoredVariables,
      source: resolved.source,
    };
  }
}
