/**
 * 内存统计事实源（开发/单测桩）。
 *
 * 实现约定：存取在此层、规则在领域层——本桩只做事实的读写与克隆返回，
 * 不做任何口径计算或业务决策（分层实现规范 §1/§2）。
 *
 * 生产环境需替换为 PostgreSQL / 正式业务记录投影的实现。
 */

import type {
  MembershipFact,
  AdmissionAcceptanceFact,
  NormalFunnelFact,
  JointConclusionFact,
} from '../domain/models/statistics-specification';
import type {
  ClubStatProfile,
  NormalRecruitmentActivityRef,
  JointActivityRef,
  StatisticsSourcePort,
} from '../application/ports/statistics-source.port';

export class InMemoryStatisticsSource implements StatisticsSourcePort {
  private profileByClub = new Map<string, ClubStatProfile>();
  private membershipsByClub = new Map<string, MembershipFact[]>();
  private admissionsByClub = new Map<string, AdmissionAcceptanceFact[]>();
  private normalActivities = new Map<string, NormalRecruitmentActivityRef>();
  private funnelFactsByActivity = new Map<string, NormalFunnelFact[]>();
  private jointActivities = new Map<string, JointActivityRef>();
  private jointConclusionsByActivity = new Map<string, JointConclusionFact[]>();
  private platformMemberships: MembershipFact[] = [];
  private platformAdmissions: AdmissionAcceptanceFact[] = [];

  // -----------------------------------------------------------------------
  // 种子方法（测试/开发初始化）
  // -----------------------------------------------------------------------

  /** 重置全部数据 */
  reset(): void {
    this.profileByClub.clear();
    this.membershipsByClub.clear();
    this.admissionsByClub.clear();
    this.normalActivities.clear();
    this.funnelFactsByActivity.clear();
    this.jointActivities.clear();
    this.jointConclusionsByActivity.clear();
    this.platformMemberships = [];
    this.platformAdmissions = [];
  }

  /** 种子社团基本信息 */
  seedClubProfile(profile: ClubStatProfile): void {
    this.profileByClub.set(profile.clubId, { ...profile });
  }

  /** 种子社团成员事实 */
  seedMembershipFacts(clubId: string, facts: readonly MembershipFact[]): void {
    this.membershipsByClub.set(
      clubId,
      facts.map((f) => ({ ...f })),
    );
  }

  /** 种子社团录取历史 */
  seedAdmissionHistory(clubId: string, facts: readonly AdmissionAcceptanceFact[]): void {
    this.admissionsByClub.set(
      clubId,
      facts.map((f) => ({ ...f })),
    );
  }

  /** 种子普通招新活动引用 */
  seedNormalActivity(ref: NormalRecruitmentActivityRef): void {
    this.normalActivities.set(ref.activityId, { ...ref });
  }

  /** 种子漏斗事实 */
  seedFunnelFacts(activityId: string, facts: readonly NormalFunnelFact[]): void {
    this.funnelFactsByActivity.set(
      activityId,
      facts.map((f) => ({ ...f })),
    );
  }

  /** 种子联合活动引用 */
  seedJointActivity(ref: JointActivityRef): void {
    this.jointActivities.set(ref.jointActivityId, { ...ref });
  }

  /** 种子联合结论事实 */
  seedJointConclusionFacts(activityId: string, facts: readonly JointConclusionFact[]): void {
    this.jointConclusionsByActivity.set(
      activityId,
      facts.map((f) => ({ ...f })),
    );
  }

  /** 种子平台全量成员 */
  seedPlatformMembershipFacts(facts: readonly MembershipFact[]): void {
    this.platformMemberships = facts.map((f) => ({ ...f }));
  }

  /** 种子平台全量录取历史 */
  seedPlatformAdmissionHistory(facts: readonly AdmissionAcceptanceFact[]): void {
    this.platformAdmissions = facts.map((f) => ({ ...f }));
  }

  // -----------------------------------------------------------------------
  // 端口实现（只读回源，每次都 clone）
  // -----------------------------------------------------------------------

  async loadClubProfile(clubId: string): Promise<ClubStatProfile | null> {
    const p = this.profileByClub.get(clubId);
    return p === undefined ? null : { ...p };
  }

  async loadMembershipFacts(clubId: string): Promise<readonly MembershipFact[]> {
    const arr = this.membershipsByClub.get(clubId);
    return arr === undefined ? [] : arr.map((f) => ({ ...f }));
  }

  async loadAdmissionHistory(clubId: string): Promise<readonly AdmissionAcceptanceFact[]> {
    const arr = this.admissionsByClub.get(clubId);
    return arr === undefined ? [] : arr.map((f) => ({ ...f }));
  }

  async loadNormalActivity(activityId: string): Promise<NormalRecruitmentActivityRef | null> {
    const ref = this.normalActivities.get(activityId);
    return ref === undefined ? null : { ...ref };
  }

  async loadNormalFunnelFacts(activityId: string): Promise<readonly NormalFunnelFact[]> {
    const arr = this.funnelFactsByActivity.get(activityId);
    return arr === undefined ? [] : arr.map((f) => ({ ...f }));
  }

  async loadJointActivity(jointActivityId: string): Promise<JointActivityRef | null> {
    const ref = this.jointActivities.get(jointActivityId);
    return ref === undefined ? null : { ...ref };
  }

  async loadJointConclusionFacts(jointActivityId: string): Promise<readonly JointConclusionFact[]> {
    const arr = this.jointConclusionsByActivity.get(jointActivityId);
    return arr === undefined ? [] : arr.map((f) => ({ ...f }));
  }

  async loadPlatformMembershipFacts(): Promise<readonly MembershipFact[]> {
    return this.platformMemberships.map((f) => ({ ...f }));
  }

  async loadPlatformAdmissionHistory(): Promise<readonly AdmissionAcceptanceFact[]> {
    return this.platformAdmissions.map((f) => ({ ...f }));
  }
}
