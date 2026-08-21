/**
 * 表单填写权限失败关闭实现（infrastructure；FORM-002、GOV-003、ORG-029 接入前）。
 *
 * organization 模块（3.2）落地前，任何“组织成员/角色”都无法核验，一律拒绝
 * （fail-closed）；不得因无法核验而放行填写操作（组织/角色由服务端身份上下文
 * 解析，客户端不得自报，IFC-GEN-001）。3.2 合并后由 organization 实现替换本桩。
 */

import type {
  FormFillPermissionInput,
  FormFillPermissionResult,
  FormFillPermissionPort,
} from '../application/ports/form-fill-permission.port';

export class NotWiredFormFillPermission implements FormFillPermissionPort {
  async canFill(_input: FormFillPermissionInput): Promise<FormFillPermissionResult> {
    return { allowed: false, reason: '填写权限未接入（organization 模块 3.2 就绪前失败关闭）' };
  }
}
