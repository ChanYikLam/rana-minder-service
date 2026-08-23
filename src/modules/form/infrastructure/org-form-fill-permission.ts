/**
 * 组织授权驱动的表单填写权限适配器（infrastructure；替换 NotWiredFormFillPermission）。
 *
 * 语义映射（FORM-002：组织成员/角色/公开匿名；ORG-038 逐请求重算）：
 * - platform 作用域：已认证主体即可填写平台公共资料表（会话链路保证认证，
 *   API-AUTH-001；本端口只在已认证前提下被调用）。
 * - club 作用域：主体为该社团现任成员（primaryRoleAt 非空，ORG-021 成员前提）。
 * - department 作用域：**保持 fail-closed**。CurrentPermissionsPort 仅提供社团级
 *   聚合（primaryRoleAt 按 clubId 查询），部门级成员解析（ORG-035）尚无契约支撑；
 *   不得因无法核验而放行（对齐设计权限与 NotWired 桩的安全立场），
 *   org 暴露部门级查询后替换本分支。
 */

import type { CurrentPermissionsPort } from '../../organization/application/ports';

import type {
  FormFillPermissionInput,
  FormFillPermissionPort,
  FormFillPermissionResult,
} from '../application/ports/form-fill-permission.port';

export class OrgBackedFormFillPermission implements FormFillPermissionPort {
  constructor(private readonly permissions: CurrentPermissionsPort) {}

  async canFill(input: FormFillPermissionInput): Promise<FormFillPermissionResult> {
    if (input.scope.kind === 'platform') {
      // 前置条件：仅已认证主体可进入（API-AUTH-001）；未认证不得调用本端口。
      return { allowed: true };
    }
    if (input.scope.kind === 'department') {
      // ORG-035：部门级成员查询无契约支撑，fail-closed（不放行、不猜测）。
      return { allowed: false, reason: 'FORM-FILL-DEPARTMENT-UNSUPPORTED' };
    }
    const ownerId = input.scope.ownerId;
    if (ownerId === null || ownerId.trim().length === 0) {
      return { allowed: false, reason: 'FORM-FILL-SCOPE-MISSING-OWNER' };
    }
    const role = await this.permissions.primaryRoleAt(input.subjectId, ownerId);
    if (role !== '') {
      return { allowed: true };
    }
    return { allowed: false, reason: 'FORM-FILL-NOT-CLUB-MEMBER' };
  }
}
