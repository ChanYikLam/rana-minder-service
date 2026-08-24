/**
 * 表单填写权限端口（form 域；FORM-002、GOV-003）。
 *
 * 判定“谁可以填写/提交已发布表单”：组织成员/角色/公开匿名。organization 模块
 * （3.2）落地前由 NotWiredFormFillPermission 失败关闭（fail-closed）。
 */

import type { FormScope } from '../../domain/models/form-scope';

export interface FormFillPermissionInput {
  readonly formId: string;
  readonly versionNumber: number;
  readonly scope: FormScope;
  readonly subjectId: string;
}

export interface FormFillPermissionResult {
  readonly allowed: boolean;
  readonly reason?: string;
}

export interface FormFillPermissionPort {
  canFill(input: FormFillPermissionInput): Promise<FormFillPermissionResult>;
}
