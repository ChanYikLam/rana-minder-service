import { Inject, Injectable } from '@nestjs/common';

import type { MembershipPeriod } from '../../domain/models/membership-period';
import { PlannedEndPolicy } from '../../domain/services/planned-end.policy';
import { MEMBERSHIP_REPOSITORY } from '../../infrastructure/membership-repository';
import type { MembershipRepository } from '../../infrastructure/membership-repository';

/** 单段经历的时间线视图 */
export interface MembershipPeriodView {
  readonly periodId: string;
  readonly clubId: string;
  readonly subjectId: string;
  readonly status: MembershipPeriod['status'];
  readonly entrySource: MembershipPeriod['entrySource'];
  /** 成员业务生效时间（= 接受/确认时间） */
  readonly businessEffectiveAt: string;
  readonly actualStartAt: string | null;
  readonly actualEndAt: string | null;
  /** 计划结束时间：仅供换届规划与提醒，绝不作为状态展示依据（MEM-012） */
  readonly plannedEndAt: string | null;
  /** 展示口径：计划时间已过但没有实际卸任事件仍为在任（MEM-012/014） */
  readonly inOffice: boolean;
  /** 前台永不展示"已逾期/到期"：本字段恒为 false（MEM-012/014，防误用显式收口） */
  readonly overdue: false;
  readonly hasResidualAnomaly: boolean;
  readonly history: MembershipPeriod['history'];
}

/**
 * 成员经历时间线查询（MEM-013：多段经历分别保存、时间线可还原）。
 *
 * 展示口径收敛在此处：任何调用方（前台/聚合接口）都不得自行依据
 * plannedEndAt 推导"已到期"状态——视图直接给出 inOffice/overdue 字段。
 */
@Injectable()
export class MemberExperienceQuery {
  constructor(
    @Inject(MEMBERSHIP_REPOSITORY) private readonly repo: MembershipRepository,
    private readonly plannedEndPolicy: PlannedEndPolicy,
  ) {}

  /** 某学生在某社团的全部经历段（最新在前） */
  async listPeriods(clubId: string, subjectId: string): Promise<MembershipPeriodView[]> {
    const periods = await this.repo.listBySubject(clubId, subjectId);
    const now = new Date();
    return periods.map((p) => this.toView(p, now));
  }

  /** 当前进行中的经历段（无则 null） */
  async currentPeriod(clubId: string, subjectId: string): Promise<MembershipPeriodView | null> {
    const active = await this.repo.findActiveBySubject(clubId, subjectId);
    if (active === null) return null;
    return this.toView(active, new Date());
  }

  private toView(p: MembershipPeriod, now: Date): MembershipPeriodView {
    return {
      periodId: p.periodId,
      clubId: p.clubId,
      subjectId: p.subjectId,
      status: p.status,
      entrySource: p.entrySource,
      businessEffectiveAt: p.businessEffectiveAt,
      actualStartAt: p.actualStartAt,
      actualEndAt: p.actualEndAt,
      plannedEndAt: p.plannedEndAt,
      inOffice: this.plannedEndPolicy.isInOfficeIgnoringPlannedEnd(p, now),
      overdue: false,
      hasResidualAnomaly: p.hasResidualAnomaly,
      history: p.history,
    };
  }
}
