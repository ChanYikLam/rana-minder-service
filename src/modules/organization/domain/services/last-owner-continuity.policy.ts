/**
 * 最后负责人连续性策略（ORG-024；SRS-SM-ORG-001 前置条件）。
 *
 * - 启用中的社团至少保留一名负责人；撤销最后一人必须在同一操作中指定继任者，
 *   严禁零负责人窗口（严禁"用户看到一个已成功但社团暂时无人负责的中间结果"）。
 * - 超级管理员紧急停用社团时，可以暂时没有负责人（ORG-028 强停前置豁免）。
 * - 人事管理员只能正式换届/经确认流程中确认负责人变更，不可平时任命/撤销负责人。
 *
 * 本策略是纯规则：不执行写入；用例层把结果并入前置校验并保证同一事务提交。
 */

import { orgError } from '../types';

export interface OwnerRevocationContext {
  /** 撤销前的现任负责人集合 */
  currentOwners: readonly string[];
  /** 本次操作中计划被撤销负责人的主体 */
  subjectId: string;
  /** 同一操作中同时授予负责人的继任者（ORG-024 最后一任交接锚点） */
  successors: readonly string[];
  /** 是否属于紧急停用场景（强停后可暂时无负责人，ORG-028） */
  emergencyBypass?: boolean;
}

export class LastOwnerContinuityPolicy {
  static assertClubHasOwner(
    ownerAgentIds: readonly string[],
    clubName: string,
    emergencyBypass = false,
  ): void {
    if (!emergencyBypass && ownerAgentIds.length === 0) {
      throw orgError.precondition(
        `社团「${clubName}」必须保留至少一名负责人（ORG-024、IFC-ERR-006）`,
      );
    }
  }

  /**
   * 校验撤销是否会造成零负责人窗口。
   * - 撤销对象不是负责人：允许（不启动继任要求）。
   * - 撤销对象是负责人且（撤销后）仍有其他负责人：允许。
   * - 撤销对象是唯一负责人：必须同一操作指定继任者，否则拒绝。
   */
  static assertNoZeroOwnerWindow(ctx: OwnerRevocationContext): void {
    if (ctx.emergencyBypass === true) return;
    const isOwner = ctx.currentOwners.includes(ctx.subjectId);
    if (!isOwner) return;
    const remainingAfterRevoke = ctx.currentOwners.filter((id) => id !== ctx.subjectId);
    if (remainingAfterRevoke.length === 0) {
      const successorGranted = ctx.successors.some((id) => id !== ctx.subjectId);
      if (!successorGranted) {
        throw orgError.precondition(
          '撤销最后一名负责人必须在同一操作中指定继任者，严禁零负责人窗口（ORG-024）',
          'lastOwner',
        );
      }
    }
  }

  /** 人事管理员对负责人变更的层级门控（ORG-021）：仅能在确认流程中处理负责人变更 */
  static assertPersonnelMayTouchLeader(
    operatorRole: 'leader' | 'personnel' | 'super_admin' | 'department_head',
    touchesLeader: boolean,
    inConfirmedTransition: boolean,
  ): void {
    if (touchesLeader && operatorRole === 'personnel' && !inConfirmedTransition) {
      throw orgError.forbidden('人事管理员仅能在正式换届/确认流程中确认负责人变更（ORG-021）');
    }
  }
}
