/**
 * 超级管理员核验失败关闭实现（infrastructure；ORG-029 接入前）。
 *
 * organization 模块（3.2）落地独立超管 Group 前，任何"超管"身份一律拒绝
 * （fail-closed）；不得因无法核验而放行高风险操作。3.2 合并后由
 * organization 实现替换本桩（identity.module 的 SUPER_ADMIN_VERIFIER 绑定）。
 */

import type { SuperAdminVerifierPort } from '../application/ports/super-admin-verifier.port';

export class NotWiredSuperAdminVerifier implements SuperAdminVerifierPort {
  async isSuperAdmin(_subjectId: string): Promise<boolean> {
    return false;
  }
}