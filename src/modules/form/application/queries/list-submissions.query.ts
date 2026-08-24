/**
 * 列出表单提交查询（FORM-002）。
 *
 * 按作用域列出；可选按表单过滤。提交列表属组织/平台管理可见范围（权限由接口层
 * 守卫控制，查询本身仅做数据检索）。
 */

import type { FormSubmissionRepository } from '../ports/form-submission-repository.port';
import type { FormSubmissionSnapshot } from '../../domain/models/form-submission';
import type { FormScope } from '../../domain/models/form-scope';

export interface ListSubmissionsInput {
  readonly scope: FormScope;
  readonly formId?: string;
}

export interface ListSubmissionsQuery {
  execute(input: ListSubmissionsInput): Promise<readonly FormSubmissionSnapshot[]>;
}

export class DefaultListSubmissionsQuery implements ListSubmissionsQuery {
  constructor(private readonly submissions: FormSubmissionRepository) {}

  async execute(input: ListSubmissionsInput): Promise<readonly FormSubmissionSnapshot[]> {
    if (input.formId !== undefined) {
      // 作用域过滤已下沉到存储层 SQL，避免跨 owner 数据进内存
      return this.submissions.listByForm(input.formId, input.scope);
    }
    return this.submissions.listByScope(input.scope);
  }
}
