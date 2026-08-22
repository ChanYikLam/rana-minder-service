/**
 * 组织授权驱动的表单填写权限适配器（infrastructure；替换 NotWiredFormFillPermission）。
 *
 * 语义映射（FORM-002：组织成员/角色/公开匿名；ORG-038 逐请求重算）：
 * - platform 作用域：已认证主体即可填写平台公共资料表（会话链路保证认证，
 *   API-AUTH-001；本端口只在已认证前提下被调用）。
 * - club / department 作用域：主体为该社团现任成员（primaryRoleAt 非空，
 *   ORG-021 成员前提）。部门作用域当前按父社团成员资格粗粒度判定：
 *   CurrentPermissionsPort 无部门级成员查询（同设计权限的 ORG-035 边界），
 *   收紧留待 org 契约扩展。
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
      return { allowed: true };
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
