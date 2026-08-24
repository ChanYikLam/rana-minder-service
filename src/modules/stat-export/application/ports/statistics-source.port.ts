/**
 * 统计事实源端口（StatisticsSourcePort，只读回源）。
 *
 * 职责（STAT-003）：统计值只能从正式业务记录计算——本端口从正式记录投影事实，
 * 不做任何业务决策或口径计算。每项事实均为不可变只读投影。
 *
 * DI 令牌：STATISTICS_SOURCE。
 */

import type {
  MembershipFact,
  AdmissionAcceptanceFact,
  NormalFunnelFact,
  JointConclusionFact,
} from '../../domain/models/statistics-specification';

// ---------------------------------------------------------------------------
// 事实源查询参数
// ---------------------------------------------------------------------------

export interface ClubStatProfile {
  readonly clubId: string;
  readonly forcedSuspension: boolean;
}

export interface NormalRecruitmentActivityRef {
  readonly activityId: string;
  readonly clubId: string;
  readonly academicYear: string;
}

export interface JointActivityRef {
  readonly jointActivityId: string;
  readonly participantClubIds: readonly string[];
}

// ---------------------------------------------------------------------------
// 端口接口
// ---------------------------------------------------------------------------

export interface StatisticsSourcePort {
  /** 社团基础信息（含停用状态） */
  loadClubProfile(clubId: string): Promise<ClubStatProfile | null>;

  /** 当前成员关系事实（按 clubId 范围回源，多部门成员按部门各一条） */
  loadMembershipFacts(clubId: string): Promise<readonly MembershipFact[]>;

  /** 录取历史事实（邀请接受即成立；不可变） */
  loadAdmissionHistory(clubId: string): Promise<readonly AdmissionAcceptanceFact[]>;

  /**
   * 活动引用（仅接受普通招新活动；联合活动返回 null）。
   * 返回 null 或 clubId 不匹配 → 视为不存在/非普通招新活动。
   */
  loadNormalActivity(activityId: string): Promise<NormalRecruitmentActivityRef | null>;

  /** 普通招新漏斗事实（活动级） */
  loadNormalFunnelFacts(activityId: string): Promise<readonly NormalFunnelFact[]>;

  /** 联合活动引用（含参与方社团清单） */
  loadJointActivity(jointActivityId: string): Promise<JointActivityRef | null>;

  /** 联合活动结论事实（活动级） */
  loadJointConclusionFacts(jointActivityId: string): Promise<readonly JointConclusionFact[]>;

  /** 平台全量成员事实（超管用） */
  loadPlatformMembershipFacts(): Promise<readonly MembershipFact[]>;

  /** 平台全量录取历史（超管用） */
  loadPlatformAdmissionHistory(): Promise<readonly AdmissionAcceptanceFact[]>;
}

// ---------------------------------------------------------------------------
// DI 令牌
// ---------------------------------------------------------------------------

export const STATISTICS_SOURCE = Symbol('STATISTICS_SOURCE');
