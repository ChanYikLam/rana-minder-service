/**
 * 邮件模板领域模型（NTF-005；需求发现 08「默认模板与社团 HTML 模板」）。
 *
 * 规则（产品行为已冻结）：
 * - 超级管理员维护平台默认通知模板；
 * - 社团各级管理员可在自身有权管理的业务范围内基于默认模板修改文字信息；
 * - 模板修改只影响后续通知；已发送的通知保留发送时的模板版本和实际内容；
 * - 固定变量白名单自动转义，不能读取任意报名表、评语或未授权字段；
 * - 自定义模板未选择、失效或未通过安全校验时，自动回退平台安全默认模板；
 * - 模板必须支持预览、测试邮件、版本保存和回滚。
 */

import type { NotificationKind } from '../../../../common/contracts/notifications.contracts';
import { sanitizeEmailHtml, type SanitizeResult } from '../services/email-html-sanitizer';
import { findIdentityOverrideAttempts } from './email-sender-identity';

/** 模板作用域 */
export type EmailTemplateScope =
  { readonly type: 'PLATFORM' } | { readonly type: 'CLUB'; readonly clubId: string };

/** 邮件模板（一个作用域 × 一个事件类型一条活跃记录＋版本历史） */
export interface EmailTemplateModel {
  readonly templateId: string;
  readonly kind: NotificationKind;
  readonly scope: EmailTemplateScope;
  /** 邮件主题（支持白名单变量占位） */
  readonly subject: string;
  /** 邮件 HTML 正文（保存前已净化） */
  readonly htmlBody: string;
  /** 活跃版本号（回滚/新存即切换） */
  readonly activeVersion: number;
  readonly updatedBy: string | null;
  readonly updatedAt: string | null;
}

/** 模板版本快照（版本保存与回滚的最小单元） */
export interface EmailTemplateVersion {
  readonly templateId: string;
  readonly version: number;
  readonly subject: string;
  readonly htmlBody: string;
  readonly createdBy: string;
  readonly createdAt: string;
  /** 版本说明（保存/回滚来源） */
  readonly note: string;
}

/** 模板渲染变量白名单（固定变量；自动转义，禁止读取任意表单字段） */
export const TEMPLATE_VARIABLE_WHITELIST = [
  'studentName',
  'clubName',
  'activityName',
  'departmentName',
  'positionName',
  'interviewTime',
  'interviewPlace',
  'conclusion',
  'deadline',
  'noticeDate',
  'platformName',
] as const;

export type TemplateVariableName = (typeof TEMPLATE_VARIABLE_WHITELIST)[number];
export type TemplateVariables = Partial<Record<TemplateVariableName, string>>;

/** HTML 转义（变量值一律转义后再插入，NTF-005.7） */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** 渲染结果 */
export interface TemplateRenderResult {
  readonly subject: string;
  readonly htmlBody: string;
  /** 被忽略的非白名单占位符名称（审计用；不回显其内容） */
  readonly ignoredVariables: readonly string[];
}

/**
 * 以白名单变量渲染模板（NTF-005.7）。
 * - 只替换白名单变量，值一律 HTML 转义；
 * - 非白名单占位符原样保留但被转义为惰性文本，并记录名称；
 * - 渲染不读取任何未授权字段——调用方只能传入白名单结构。
 */
export function renderEmailTemplate(
  subject: string,
  htmlBody: string,
  variables: TemplateVariables,
): TemplateRenderResult {
  const ignored: string[] = [];
  const safeVars = new Map<string, string>();
  for (const [key, value] of Object.entries(variables)) {
    if (
      TEMPLATE_VARIABLE_WHITELIST.includes(key as TemplateVariableName) &&
      typeof value === 'string'
    ) {
      safeVars.set(key, escapeHtml(value));
    } else {
      ignored.push(key);
    }
  }

  const substitute = (text: string): string =>
    text.replace(/\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g, (raw, name: string) => {
      const value = safeVars.get(name);
      // 非白名单占位符：转义为惰性文本保留，不展开
      return value ?? escapeHtml(raw);
    });

  return {
    subject: substitute(subject),
    htmlBody: substitute(htmlBody),
    ignoredVariables: ignored,
  };
}

/** 模板安全校验结果 */
export interface TemplateSafetyResult {
  readonly safe: boolean;
  /** 净化后的 HTML（safe=false 时为 null） */
  readonly sanitizedHtml: string | null;
  readonly violations: readonly string[];
}

/**
 * 校验并净化模板正文（NTF-005.5）。
 * 同时拦截邮件头注入式发件身份覆盖（NTF-008.3）：
 * 任何一项违规即整体不安全 → 调用方回退平台安全默认模板。
 */
export function validateTemplateSafety(subject: string, htmlBody: string): TemplateSafetyResult {
  const violations: string[] = [];
  const identityAttempts = findIdentityOverrideAttempts(subject + '\n' + htmlBody);
  violations.push(...identityAttempts);

  // 主题不允许包含换行（头注入）与 HTML 标记
  if (/[\r\n]/.test(subject) || /<[^>]+>/.test(subject)) {
    violations.push('邮件主题不得包含换行或 HTML 标记');
  }

  const sanitized: SanitizeResult = sanitizeEmailHtml(htmlBody);
  if (sanitized.hadViolations) {
    // 净化器已移除危险内容：视为未通过安全校验（回退默认模板），
    // 同时保留违规描述供预览提示与审计。
    violations.push(...sanitized.violations);
  }

  if (violations.length > 0) {
    return { safe: false, sanitizedHtml: null, violations };
  }
  // 无违规：净化输出（等价输入，防御性再净化）
  return { safe: true, sanitizedHtml: sanitized.html, violations: [] };
}
