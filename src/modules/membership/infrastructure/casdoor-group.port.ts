import { Injectable } from '@nestjs/common';

import type { MembershipRelationTarget } from '../domain/models/membership-period';

/** Casdoor Group 适配注入令牌（MembershipCasdoorPort 为接口，注入须用显式 token） */
export const MEMBERSHIP_CASDOOR_PORT = Symbol('MEMBERSHIP_CASDOOR_PORT');

/** 单个目标关系的写入/回读结果（CAS-WR-*：逐步幂等、逐项回读，ORG-027） */
export interface GroupStepResult {
  readonly target: MembershipRelationTarget;
  /** 写入请求是否成功受理（unknown 归入 false 并以 reason 说明） */
  readonly ok: boolean;
  /** 定向回读确认（未确认不开放权限/不收口） */
  readonly confirmed: boolean;
  /** 技术原因（脱敏后保存） */
  readonly reason?: string;
}

/**
 * Casdoor 社团/部门/职位 Group 写读端口（ADR-009、IFC-TX-003、ORG-027）。
 *
 * membership 编排语义：
 * - 激活：先写社团 Group 再写组合部门/职位 Group，逐项回读；全部确认才生效；
 * - 补偿：对已写入目标逐项移除并回读（每步幂等），全部确认才算补偿收口；
 * - 退出执行：移除社团＋快照内全部部门/职位 Group，逐项回读；任一残留不收口。
 */
export interface MembershipCasdoorPort {
  /** 逐项加入并回读（激活路径）；返回顺序与 targets 一致 */
  addAndReadBack(
    clubId: string,
    subjectId: string,
    targets: readonly MembershipRelationTarget[],
    idempotencyKey: string,
  ): Promise<GroupStepResult[]>;
  /** 逐项移除并回读（补偿/退出执行路径）；返回顺序与 targets 一致 */
  removeAllAndReadBack(
    clubId: string,
    subjectId: string,
    targets: readonly MembershipRelationTarget[],
    idempotencyKey: string,
  ): Promise<GroupStepResult[]>;
  /**
   * 只回读不移除（转换 7：失败恢复前必须先确认"原关系仍完整有效"）。
   * 返回每个目标当前是否仍包含该成员。
   */
  confirmRelationsIntact(
    clubId: string,
    subjectId: string,
    targets: readonly MembershipRelationTarget[],
  ): Promise<boolean>;
  /**
   * 枚举该成员在该社团范围当前仍存在的全部 Group 关系（只读；ORG-030）：
   * 退出收口（转换 6）在 PERIOD_ENDED 前必须校验其为空——快照遗漏的残留关系
   * 不得被静默放过，防止非成员保留子级权限。
   */
  listActiveRelationTargets(clubId: string, subjectId: string): Promise<MembershipRelationTarget[]>;
}

/** 占位实现（开发期直接确认；真实接入由 Casdoor 统一适配提供，ADR-009） */
@Injectable()
export class DefaultMembershipCasdoorPort implements MembershipCasdoorPort {
  async addAndReadBack(
    _clubId: string,
    _subjectId: string,
    targets: readonly MembershipRelationTarget[],
    _idempotencyKey: string,
  ): Promise<GroupStepResult[]> {
    // 开发期占位：直接写入成功且回读确认（生产由 Casdoor 适配器实现）
    return targets.map((target) => ({ target, ok: true, confirmed: true }));
  }

  async removeAllAndReadBack(
    _clubId: string,
    _subjectId: string,
    targets: readonly MembershipRelationTarget[],
    _idempotencyKey: string,
  ): Promise<GroupStepResult[]> {
    return targets.map((target) => ({ target, ok: true, confirmed: true }));
  }

  async confirmRelationsIntact(
    _clubId: string,
    _subjectId: string,
    _targets: readonly MembershipRelationTarget[],
  ): Promise<boolean> {
    return true;
  }

  async listActiveRelationTargets(
    _clubId: string,
    _subjectId: string,
  ): Promise<MembershipRelationTarget[]> {
    // 开发期占位：无残留（生产按 Casdoor 当前 Group 成员关系回读枚举）
    return [];
  }
}
