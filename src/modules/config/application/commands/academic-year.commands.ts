/**
 * 学年与届次命令/查询（CFG-003，5.5.3）。
 *
 * 需求关键句：「学年由系统根据平台时区和可配置的年度分界日自动生成、命名并切换当前
 * 值，不要求超级管理员逐年手工创建」「社团负责人或人事管理员维护本社团届次名称并关联
 * 一个系统学年」「超管仅可因校历变化调整未来分界规则，变更须审计，已被业务使用的历史
 * 学年不得被自动重写」。
 *
 * 历史保护规则：分界规则变更后重新生成的学年，凡与已生成且已开始的学年同名但起止
 * 时刻不一致 → 拒绝（CFG_CONFLICT）；未开始学年的重算视为「未来规则调整」，允许替换。
 */

import {
  academicYearNameForDate,
  assertNoOverlap,
  generateAcademicYears,
  resolveCurrentAcademicYear,
  validateBoundary,
  type AcademicYearSnapshot,
} from '../../domain/models/academic-year';
import { randomUUID } from 'node:crypto';

import { ClubCohort } from '../../domain/models/club-cohort';
import type { ClubCohortSnapshot } from '../../domain/models/club-cohort';
import type {
  AcademicYearBoundaryRepositoryPort,
  CohortRepositoryPort,
  PolicyAuthorizationPort,
} from '../ports';
import type { ConfigAuditPort } from '../../infrastructure/not-wired.config-ports';
import { cfgErrors } from '../errors';

/** 平台初始化默认分界规则（CFG-003：首个分界日与时区进平台配置清单；8 月 1 日契合高校校历） */
export const DEFAULT_BOUNDARY = { month: 8, day: 1, timeZone: 'Asia/Shanghai' } as const;

const DEFAULT_GENERATE_COUNT = 6;

async function loadOrCreateSettings(repository: AcademicYearBoundaryRepositoryPort): Promise<{
  boundary:
    typeof DEFAULT_BOUNDARY | import('../../domain/models/academic-year').AcademicYearBoundary;
  generatedYears: AcademicYearSnapshot[];
}> {
  const snapshot = await repository.load();
  if (snapshot !== null) {
    return { boundary: snapshot.boundary, generatedYears: [...snapshot.generatedYears] };
  }
  return { boundary: { ...DEFAULT_BOUNDARY }, generatedYears: [] };
}

export interface UpdateAcademicYearBoundaryInput {
  readonly subjectId: string;
  readonly now: Date;
  readonly month: number;
  readonly day: number;
  readonly timeZone: string;
  /** 重新生成的学年数量（含当前学年起）；缺省 6 */
  readonly generateCount?: number;
}

export class UpdateAcademicYearBoundaryCommand {
  constructor(
    private readonly repository: AcademicYearBoundaryRepositoryPort,
    private readonly authorization: PolicyAuthorizationPort,
    private readonly audit: ConfigAuditPort,
  ) {}

  async execute(input: UpdateAcademicYearBoundaryInput): Promise<{
    boundary: { month: number; day: number; timeZone: string };
    current: AcademicYearSnapshot;
    generatedYears: readonly AcademicYearSnapshot[];
  }> {
    if (!(await this.authorization.canManagePlatform(input.subjectId))) {
      throw cfgErrors.forbidden('仅平台超管可调整学年分界规则');
    }
    validateBoundary(input.month, input.day);
    const boundary = { month: input.month, day: input.day, timeZone: input.timeZone };

    const settings = await loadOrCreateSettings(this.repository);
    const previousBoundary = settings.boundary;

    // 以「当前学年的起始日历年」为窗口起点重新生成（覆盖当前+未来）
    const currentName = academicYearNameForDate(input.now, boundary);
    const startCalendarYear = Number(currentName.split('-')[0]);
    const regenerated = generateAcademicYears({
      boundary,
      firstCalendarYear: startCalendarYear,
      count: input.generateCount ?? DEFAULT_GENERATE_COUNT,
    });

    // 历史学年保护（区间交叠口径，CFG-003）：
    // 任何与新窗口区间交叠的存量学年，凡非「同名且起止完全一致」——
    // 已开始 → CFG_CONFLICT 拒绝；未开始 → 由重新生成结果取代。
    // 仅按名比对不足以防数据丢失：改名规则下旧名年份与新区间交叠但名字不同，
    // 会被静默丢弃（P1 教训），故必须以区间交叠审视。
    const intersects = (a: AcademicYearSnapshot, b: AcademicYearSnapshot): boolean =>
      a.startDate.getTime() <= b.endDate.getTime() && b.startDate.getTime() <= a.endDate.getTime();
    for (const existing of settings.generatedYears) {
      if (!regenerated.some((r) => intersects(r, existing))) {
        continue;
      }
      const identical = regenerated.some(
        (r) =>
          r.name === existing.name &&
          r.startDate.getTime() === existing.startDate.getTime() &&
          r.endDate.getTime() === existing.endDate.getTime(),
      );
      if (identical) {
        continue;
      }
      if (existing.startDate.getTime() <= input.now.getTime()) {
        throw cfgErrors.conflict(
          `分界规则变更将改写已开始的历史学年:${existing.name}（CFG-003 历史保护）`,
        );
      }
    }

    // 合并：被新窗口覆盖（含同名复刻）的存量让位于重新生成结果；
    // 与新窗口不交叠的存量（含全部已结束历史）原样保留；整体不得重叠。
    const replacedNames = new Set(regenerated.map((r) => r.name));
    const kept = settings.generatedYears.filter((existing) => {
      if (replacedNames.has(existing.name)) {
        return false;
      }
      return !regenerated.some((r) => intersects(r, existing));
    });
    const merged = [...kept, ...regenerated].sort(
      (a, b) => a.startDate.getTime() - b.startDate.getTime(),
    );
    assertNoOverlap(merged);

    await this.repository.save({
      boundary,
      generatedYears: merged,
      lastChangedBy: input.subjectId,
      lastChangedAt: input.now,
    });

    // 分界规则变更审计（CFG-003「变更须审计」；同事务收口随 AUD-003 接线）
    await this.audit.recordBoundaryChange({
      by: input.subjectId,
      at: input.now,
      from: previousBoundary,
      to: boundary,
    });
    return {
      boundary,
      current: resolveCurrentAcademicYear(input.now, boundary),
      generatedYears: merged,
    };
  }
}

export class GetCurrentAcademicYearQuery {
  constructor(private readonly repository: AcademicYearBoundaryRepositoryPort) {}

  async execute(input: { now: Date }): Promise<{
    boundary: { month: number; day: number; timeZone: string };
    current: AcademicYearSnapshot;
    knownYears: readonly string[];
  }> {
    const settings = await loadOrCreateSettings(this.repository);
    return {
      boundary: settings.boundary,
      current: resolveCurrentAcademicYear(input.now, settings.boundary),
      knownYears: settings.generatedYears.map((y) => y.name),
    };
  }
}

// --------------------------------------------------------------------------
// 社团届次（负责人/人事维护；切换学年不自动创建届次/换届）
// --------------------------------------------------------------------------

export interface CreateCohortInput {
  readonly clubId: string;
  readonly subjectId: string;
  readonly now: Date;
  readonly name: string;
  /** 关联系统学年名；缺省=当前学年（新建活动/任期/统计默认当前学年，CFG-003） */
  readonly academicYearName?: string;
  /** 届次稳定标识（幂等键/UUIDv7 由接口层生成后传入） */
  readonly cohortId?: string;
}

export class CreateCohortCommand {
  constructor(
    private readonly cohortRepository: CohortRepositoryPort,
    private readonly boundaryRepository: AcademicYearBoundaryRepositoryPort,
    private readonly authorization: PolicyAuthorizationPort,
  ) {}

  async execute(input: CreateCohortInput): Promise<ClubCohortSnapshot> {
    if (!(await this.authorization.canManageClub(input.clubId, input.subjectId))) {
      throw cfgErrors.forbidden('仅社团负责人/人事可维护本社团届次');
    }
    const settings = await loadOrCreateSettings(this.boundaryRepository);
    const knownYears =
      settings.generatedYears.length > 0
        ? settings.generatedYears.map((y) => y.name)
        : [academicYearNameForDate(input.now, settings.boundary)];
    const targetYear =
      input.academicYearName ?? academicYearNameForDate(input.now, settings.boundary);

    const duplicate = (await this.cohortRepository.listByClub(input.clubId)).find(
      (c) => c.academicYearName === targetYear && c.name === input.name.trim(),
    );
    if (duplicate) {
      throw cfgErrors.conflict('同社团下同学年已存在同名届次');
    }

    const cohort = ClubCohort.create({
      id: input.cohortId ?? randomUUID(),
      clubId: input.clubId,
      name: input.name,
      academicYearName: targetYear,
      createdBy: input.subjectId,
      now: input.now,
      knownYears,
    });
    const snapshot = cohort.toSnapshot();
    await this.cohortRepository.save(snapshot);
    return snapshot;
  }
}

export interface RenameCohortInput {
  readonly clubId: string;
  readonly cohortId: string;
  readonly subjectId: string;
  readonly now: Date;
  readonly newName: string;
}

export class RenameCohortCommand {
  constructor(
    private readonly cohortRepository: CohortRepositoryPort,
    private readonly authorization: PolicyAuthorizationPort,
  ) {}

  async execute(input: RenameCohortInput): Promise<ClubCohortSnapshot> {
    const existing = await this.cohortRepository.findById(input.cohortId);
    if (existing === null || existing.clubId !== input.clubId) {
      throw cfgErrors.notFound('社团届次');
    }
    if (!(await this.authorization.canManageClub(existing.clubId, input.subjectId))) {
      throw cfgErrors.forbidden('仅社团负责人/人事可维护本社团届次');
    }
    const cohort = ClubCohort.fromSnapshot(existing);
    cohort.rename(input.newName, { by: input.subjectId, now: input.now });
    const snapshot = cohort.toSnapshot();
    await this.cohortRepository.save(snapshot);
    return snapshot;
  }
}

/**
 * 届次列表查询（CFG-003）。授权（评审修复）：本社团成员可见自己社团的
 * 届次沿革；负责人/人事与平台超管天然可见；无关主体拒绝（fail-closed）。
 */
export class ListCohortsQuery {
  constructor(
    private readonly cohortRepository: CohortRepositoryPort,
    private readonly authorization: PolicyAuthorizationPort,
    private readonly membership: import('../ports').ClubMembershipPort,
  ) {}

  async execute(input: {
    clubId: string;
    subjectId: string;
  }): Promise<readonly ClubCohortSnapshot[]> {
    const allowed =
      (await this.membership.isMember(input.clubId, input.subjectId)) ||
      (await this.authorization.canManageClub(input.clubId, input.subjectId)) ||
      (await this.authorization.canManagePlatform(input.subjectId));
    if (!allowed) {
      throw cfgErrors.forbidden('仅本社团成员或管理者可查看届次');
    }
    return this.cohortRepository.listByClub(input.clubId);
  }
}
