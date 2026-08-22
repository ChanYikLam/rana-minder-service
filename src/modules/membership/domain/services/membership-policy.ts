/**
 * 成员生命周期权限与前置规则（MEM-002/005/007/008/013，SRS-SM-MEM-001 前置条件）。
 *
 * 纯规则：不执行写入；用例层把结果并入前置校验并保证同一事务提交。
 * 最后负责人连续性复用组织模块 ORG-024 策略（membership README：负责人连续性判定
 * 由 organization 模块提供），本文件只做角色门控与二次确认等本域规则。
 */

export const MEMBER_ROLE = 'MEMBER';
export const DEPARTMENT_LEADER_ROLE = 'DEPARTMENT_LEADER';
// 负责人/人事角色定义与邀请模块保持同一字符串语义（REC-024/MEM-005）
export const CLUB_LEADER_ROLE = 'CLUB_LEADER';
export const HR_ADMIN_ROLE = 'HR_ADMIN';
export const SUPER_ADMIN_ROLE = 'SUPER_ADMIN';

/** 可审批主动退出的角色集合：任一社团负责人或人事管理员；部门负责人无权（MEM-005） */
const DEPARTURE_APPROVER_ROLES: readonly string[] = [CLUB_LEADER_ROLE, HR_ADMIN_ROLE];

/** 无权异常（IFC-ERR-003 当前无权） */
export class MembershipForbiddenError extends Error {
  constructor(message: string) {
    super(`IFC-ERR-003: ${message}`);
    this.name = 'MembershipForbiddenError';
  }
}

/** 前置失败异常（IFC-ERR-006 业务前置条件失败） */
export class MembershipPreconditionError extends Error {
  constructor(message: string) {
    super(`IFC-ERR-006: ${message}`);
    this.name = 'MembershipPreconditionError';
  }
}

/** 成员生命周期策略（纯规则） */
export class MembershipPolicy {
  /** 进入资格门（转换 1）：账号有效/社团启用/资料门满足由调用方复核后传入 */
  assertEntryEligibility(eligibilityOk: boolean): void {
    if (!eligibilityOk) {
      throw new MembershipPreconditionError(
        '账号/社团状态/资料门校验未通过，不能进入成员生效处理中',
      );
    }
  }

  /** 主动退出审批人：任一社团负责人或人事管理员；部门负责人无权（MEM-005） */
  assertCanApproveDeparture(roles: readonly string[]): void {
    if (!roles.some((r) => DEPARTURE_APPROVER_ROLES.includes(r))) {
      throw new MembershipForbiddenError('仅社团负责人/人事管理员可审批成员退出（部门负责人无权）');
    }
  }

  /** 审批人不能审批自己的退出（MEM-005）；移除者不能通过移除入口处理自己（MEM-008） */
  assertNotSelf(approverId: string, subjectId: string): void {
    if (approverId === subjectId) {
      throw new MembershipForbiddenError('不能审批/移除自己：本人离开应走退出或辞职流程');
    }
  }

  /** 主动退出必须本人二次确认后才进入待审批（MEM-002） */
  assertSecondConfirmed(confirmed: boolean): void {
    if (!confirmed) {
      throw new MembershipPreconditionError('退出申请必须完成本人二次确认');
    }
  }

  /** 驳回必须填写原因（MEM-005） */
  assertRejectionReason(reason: string | null | undefined): void {
    if (reason === null || reason === undefined || reason.trim() === '') {
      throw new MembershipPreconditionError('驳回退出申请必须填写原因');
    }
  }

  /** 管理员移除必须填写原因并二次确认（MEM-008） */
  assertRemovalConfirmed(reason: string | null | undefined, secondConfirmed: boolean): void {
    if (reason === null || reason === undefined || reason.trim() === '') {
      throw new MembershipPreconditionError('主动移除必须填写原因（MEM-008）');
    }
    if (!secondConfirmed) {
      throw new MembershipPreconditionError('主动移除必须二次确认（MEM-008）');
    }
  }

  /**
   * 管理员移除层级门控（MEM-008）：
   * - 普通成员 / 部门负责人：社团负责人或人事管理员可移除；
   * - 人事管理员：仅社团负责人；
   * - 社团负责人：另一名现任负责人，紧急情况超级管理员；
   * 目标角色按其当前职位 Group 主角色判定（GOV-007 派生仅限内存桩）。
   */
  assertCanRemoveTarget(operatorRoles: readonly string[], targetRole: string): void {
    const isLeader = operatorRoles.includes(CLUB_LEADER_ROLE);
    const isHr = operatorRoles.includes(HR_ADMIN_ROLE);
    const isSuper = operatorRoles.includes(SUPER_ADMIN_ROLE);
    switch (targetRole) {
      case MEMBER_ROLE:
      case DEPARTMENT_LEADER_ROLE:
        if (!isLeader && !isHr) {
          throw new MembershipForbiddenError('移除普通成员/部门负责人需社团负责人或人事管理员');
        }
        return;
      case HR_ADMIN_ROLE:
        if (!isLeader) {
          throw new MembershipForbiddenError('移除人事管理员仅社团负责人可操作');
        }
        return;
      case CLUB_LEADER_ROLE:
        if (!isLeader && !isSuper) {
          throw new MembershipForbiddenError(
            '移除社团负责人须另一名现任负责人或超级管理员紧急处置',
          );
        }
        return;
      default:
        throw new MembershipPreconditionError(`未知目标主角色：${targetRole}`);
    }
  }

  /** 手工重试退出执行必须重新鉴权（ORG-027：人工重试重新鉴权且不重复审批决定） */
  assertCanRetryDeparture(roles: readonly string[]): void {
    if (!roles.some((r) => DEPARTURE_APPROVER_ROLES.includes(r))) {
      throw new MembershipForbiddenError('人工重试退出执行需社团负责人/人事管理员重新鉴权');
    }
  }
}
