/**
 * 表单设计权限失败关闭实现（infrastructure；FORM-002、GOV-003、ORG-029 接入前）。
 *
 * 权限分级：platform → 平台超管；club → 社团负责人/人事；department → 部门负责人。
 * organization 模块（3.2）落地前，任何"超管/负责人/人事"角色都无法核验，一律
 * 拒绝（fail-closed）；不得因无法核验而放行高风险操作（组织/角色由服务端身份
 * 上下文解析，客户端不得自报角色，IFC-GEN-001）。3.2 合并后由 organization
 * 实现替换本桩（form.module 的 FORM_DESIGN_PERMISSION 绑定）。
 */

import type { FormScope } from '../domain/models/form-scope';
import type { FormDesignPermissionPort } from '../application/ports/form-design-permission.port';

export class NotWiredFormDesignPermission implements FormDesignPermissionPort {
  async canDesign(_subject: { readonly subjectId: string }, _scope: FormScope): Promise<boolean> {
    return false;
  }

  async canManagePlatform(_subject: { readonly subjectId: string }): Promise<boolean> {
    return false;
  }
}
