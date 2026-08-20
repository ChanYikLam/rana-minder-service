/**
 * 超级管理员核验端口（ORG-029 依赖边界）。
 *
 * 超级管理员由独立 Casdoor Group 提供（不属于任何社团）；部署初始化时建立。
 * organization 模块（3.2）落地后由该模块实现；当前接入失败关闭实现
 * （未验证的"超管"一律拒绝），不得自行猜测角色（ADR-009 §2.1）。
 */

export interface SuperAdminVerifierPort {
  isSuperAdmin(subjectId: string): Promise<boolean>;
}
