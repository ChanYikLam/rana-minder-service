/**
 * 计划结束时间策略（MEM-010/012/014、CFG-003）.
 *
 * 计划任期结束时间只用于内部历史、提前提醒和换届规划：
 * - 不触发自动卸任，不自动撤销 Casdoor Group 或系统权限；
 * - 实际卸任只由换届生效、辞职审批生效或有权管理员免职触发；
 * - 前台不展示"已逾期"或到期状态；没有实际卸任事件就仍显示在任。
 *
 * 纯规则：供任何"按计划时间批量收口"的调度路径前置调用——凡试图仅因
 * 计划时间到达而结束经历/撤权的调用在此被拒绝（IFC-ERR-007 状态冲突）。
 */

import type { MembershipPeriod } from '../models/membership-period';
import { MembershipPeriodStatus } from '../state-machines/membership-period.state-machine';

export class PlannedEndPolicy {
  /**
   * 拒绝"仅因计划时间到达"的自动卸任尝试（IFC-ERR-007 状态冲突）。
   * 调度器不得把 plannedEndAt 当作权限状态使用（MEM-012）；
   * 合法的结束只能来自换届/辞职生效/免职/退出/移除等显式业务命令。
   */
  assertNoAutoEndAtPlannedEnd(plannedEndAt: string | null, now: Date): void {
    if (plannedEndAt !== null && Date.parse(plannedEndAt) <= now.getTime()) {
      throw new Error(
        'IFC-ERR-007: 计划结束时间到达不触发自动卸任或撤权（MEM-010/012），须走换届/辞职/免职等显式业务流程',
      );
    }
  }

  /**
   * 展示规则（MEM-012/014）：只要没有实际卸任事件，即使计划时间已过仍为"在任"；
   * 调用方不得依据 plannedEndAt 把当前成员显示为已到期/已逾期。
   */
  isInOfficeIgnoringPlannedEnd(period: MembershipPeriod, now: Date): boolean {
    if (period.status !== MembershipPeriodStatus.CURRENT_MEMBER) return false;
    // 实际结束只可能出现在终态；当前成员必然没有实际卸任事件
    void now;
    return period.actualEndAt === null;
  }
}
