/**
 * 部门关系申请策略（SRS-SM-MEM-003 前置规则；MEM-009/017、ORG-036）。
 *
 * 纯规则：不执行写入；用例层把结果并入前置校验并保证同一事务提交。
 * 审批人数据由 RelationDirectoryPort / MembershipAccessPort 服务端重算传入。
 */

import type { DepartmentApplicationType } from '../models/department-application';

/** 无权异常（IFC-ERR-003 当前无权） */
export class ApplicationForbiddenError extends Error {
  constructor(message: string) {
    super(`IFC-ERR-003: ${message}`);
    this.name = 'ApplicationForbiddenError';
  }
}

/** 前置失败异常（IFC-ERR-006 业务前置条件失败） */
export class ApplicationPreconditionError extends Error {
  constructor(message: string) {
    super(`IFC-ERR-006: ${message}`);
    this.name = 'ApplicationPreconditionError';
  }
}

/** 提交上下文（用例层从端口重算后传入） */
export interface ApplicationSubmitContext {
  /** 申请人是否当前社团成员 */
  readonly applicantIsMember: boolean;
  /** 目标部门是否有效（join/transfer 必须有效） */
  readonly targetDeptActive: boolean | null;
  /** 申请人当前所在部门 id 集合（leave/transfer 的退出范围校验依据） */
  readonly applicantDepartmentIds: readonly string[];
  /** 是否已存在同主体同类型的待审批申请（无冲突待处理申请约束） */
  readonly hasConflictingPending: boolean;
}

/** 审批上下文 */
export interface ApplicationDecisionContext {
  readonly operatorRoles: readonly string[];
  readonly operatorId: string;
  readonly applicantId: string;
  /** 操作者是否为目标部门负责人（部门负责人仅本部门目标申请 MEM-017） */
  readonly operatorLeadsTargetDept: boolean;
  /** 部门是否有现任负责人（无负责人时回退社团负责人/人事 ORG-036） */
  readonly departmentHasLeader: boolean;
}

/** 部门关系申请策略（纯规则） */
export class DepartmentApplicationPolicy {
  /**
   * 提交前置（A1）：本人是当前成员；目标部门有效；范围明确；
   * 调动列出加入目标和选择退出的原部门；无冲突待处理申请。
   */
  assertSubmittable(
    ctx: ApplicationSubmitContext,
    type: DepartmentApplicationType,
    targetDeptId: string | null,
    leaveDeptIds: readonly string[],
  ): void {
    if (!ctx.applicantIsMember) {
      throw new ApplicationPreconditionError('仅当前社团成员可提交部门关系申请');
    }
    switch (type) {
      case 'JOIN':
        if (targetDeptId === null || ctx.targetDeptActive !== true) {
          throw new ApplicationPreconditionError('加入申请必须指定有效目标部门');
        }
        if (leaveDeptIds.length > 0) {
          throw new ApplicationPreconditionError('加入申请不得携带退出部门');
        }
        break;
      case 'LEAVE':
        if (leaveDeptIds.length === 0) {
          throw new ApplicationPreconditionError('退出申请必须明确选择退出的原部门');
        }
        break;
      case 'TRANSFER':
        if (targetDeptId === null || ctx.targetDeptActive !== true) {
          throw new ApplicationPreconditionError('调动申请必须指定有效目标部门');
        }
        if (leaveDeptIds.length === 0) {
          throw new ApplicationPreconditionError('调动申请必须列出选择退出的原部门');
        }
        break;
      default: {
        const exhaustive: never = type;
        void exhaustive;
        throw new ApplicationPreconditionError('未知申请类型');
      }
    }
    // 退出范围必须属于申请人当前所在部门（范围越界拒绝）
    for (const deptId of leaveDeptIds) {
      if (!ctx.applicantDepartmentIds.includes(deptId)) {
        throw new ApplicationPreconditionError(`退出范围包含未加入的部门（${deptId}）`);
      }
    }
    if (ctx.hasConflictingPending) {
      throw new ApplicationPreconditionError('已存在同类型待处理申请，处理完成前不能重复提交');
    }
  }

  /** 申请人本人不能审批自己的申请（MEM-009/017、ORG-036 自审排除） */
  assertNotSelf(operatorId: string, applicantId: string): void {
    if (operatorId === applicantId) {
      throw new ApplicationForbiddenError('申请人不能审批自己的申请（ORG-036）');
    }
  }

  /**
   * 审批权门（A3/A4）：对应部门负责人、社团负责人或人事管理员；
   * 部门负责人仅本部门目标申请；无部门负责人时回退社团负责人/人事（ORG-036）。
   */
  assertCanDecide(ctx: ApplicationDecisionContext): void {
    if (ctx.operatorRoles.includes('CLUB_LEADER') || ctx.operatorRoles.includes('HR_ADMIN')) {
      return; // 社团负责人/人事：全局审批
    }
    // 无现任负责人的部门回退到负责人/人事（上一分支已覆盖）；有负责人的部门：
    if (!ctx.departmentHasLeader) {
      throw new ApplicationForbiddenError('无部门负责人时应由社团负责人/人事审批（ORG-036）');
    }
    if (!ctx.operatorLeadsTargetDept) {
      throw new ApplicationForbiddenError('部门负责人仅能审批本部门目标申请（MEM-017）');
    }
  }

  /** 驳回必须填写原因（A3） */
  assertRejectReason(reason: string | null | undefined): void {
    if (reason === null || reason === undefined || reason.trim() === '') {
      throw new ApplicationPreconditionError('驳回申请必须填写原因');
    }
  }

  /** 撤回必须本人二次确认（A2） */
  assertWithdrawConfirmed(applicantId: string, operatorId: string, secondConfirmed: boolean): void {
    if (operatorId !== applicantId) {
      throw new ApplicationForbiddenError('仅申请人本人可撤回申请');
    }
    if (!secondConfirmed) {
      throw new ApplicationPreconditionError('撤回申请必须完成本人二次确认');
    }
  }

  /** 执行启动/人工重试权限（当前有权执行者＝社团负责人/人事） */
  assertCanExecute(operatorRoles: readonly string[]): void {
    if (
      !operatorRoles.includes('CLUB_LEADER') &&
      !operatorRoles.includes('HR_ADMIN') &&
      !operatorRoles.includes('SUPER_ADMIN')
    ) {
      throw new ApplicationForbiddenError('仅社团负责人/人事管理员可执行已批准的申请');
    }
  }
}
