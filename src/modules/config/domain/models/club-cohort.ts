/**
 * 社团届次纯领域聚合（CFG-003，5.5.3）。
 *
 * 「社团负责人或人事管理员维护本社团届次名称并关联一个系统学年」。
 * 本聚合只建模届次本身（命名 + 关联学年 + 乐观锁留痕），不含数据库、
 * HTTP 与依赖注入。
 *
 * 关键不变量（CFG-003）：
 * - 「系统切换学年不自动创建届次、不结束招新活动、不执行换届、卸任干部
 *   或改变成员关系」——届次的产生与换届始终是明确的社团管理行为；
 * - 届次必须关联一个已生成的系统学年（validateLinkedAcademicYear）；
 * - 本聚合根本不提供修改 academicYearName 的方法：换届（更换关联学年）
 *   须新建届次；rename 只允许改届次显示名称。
 */

import { ConfigDomainError } from '../errors';

/** 届次名称长度上限 */
export const MAX_COHORT_NAME_LENGTH = 50;

export interface ClubCohortSnapshot {
  readonly id: string;
  readonly clubId: string;
  /** 届次名称：由社团负责人/人事维护，trim 后非空且 ≤50 字符 */
  readonly name: string;
  /** 关联的系统学年名（'YYYY-YYYY+1'）；创建后不可变——换届须新建届次 */
  readonly academicYearName: string;
  /** 乐观锁：每次改名 +1 */
  readonly revisionNumber: number;
  readonly createdBy: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  /** 最近一次改名的操作者；创建后未改名时为 null */
  readonly updatedBy: string | null;
}

/**
 * 校验并规范化届次名称：trim 后非空且 ≤50 字符，
 * 返回 trim 后的名称，否则抛 CFG_VALIDATION。
 */
export function validateCohortName(name: string): string {
  const trimmed = name.trim();
  if (trimmed.length === 0) {
    throw new ConfigDomainError('CFG_VALIDATION', '届次名称不能为空', { field: 'name' });
  }
  if (trimmed.length > MAX_COHORT_NAME_LENGTH) {
    throw new ConfigDomainError(
      'CFG_VALIDATION',
      `届次名称长度不能超过 ${MAX_COHORT_NAME_LENGTH} 个字符`,
      { field: 'name' },
    );
  }
  return trimmed;
}

/**
 * 校验届次关联的系统学年：必须命中已知系统学年名单
 * （CFG-003：届次关联到系统学年），否则抛 CFG_VALIDATION。
 * 学年名做精确匹配（系统生成的规范名，不做 trim 容错）。
 */
export function validateLinkedAcademicYear(
  academicYearName: string,
  knownYears: readonly string[],
): string {
  if (!knownYears.includes(academicYearName)) {
    throw new ConfigDomainError('CFG_VALIDATION', '届次必须关联已生成的系统学年', {
      academicYearName,
    });
  }
  return academicYearName;
}

/**
 * 社团届次聚合。
 *
 * 切换当前学年不会触发本聚合的任何行为：不自动创建届次、不结束招新、
 * 不执行换届、不改变成员关系（CFG-003）。换届须新建届次，
 * 因此本聚合不提供任何修改 academicYearName 的方法。
 */
export class ClubCohort {
  private constructor(private snapshot: ClubCohortSnapshot) {}

  static create(input: {
    id: string;
    clubId: string;
    name: string;
    academicYearName: string;
    createdBy: string;
    now: Date;
    knownYears: readonly string[];
  }): ClubCohort {
    return new ClubCohort({
      id: input.id,
      clubId: input.clubId,
      // 创建走两个校验：名称规范化 + 关联系统学年命中
      name: validateCohortName(input.name),
      academicYearName: validateLinkedAcademicYear(input.academicYearName, input.knownYears),
      revisionNumber: 1,
      createdBy: input.createdBy,
      createdAt: input.now,
      updatedAt: input.now,
      updatedBy: null,
    });
  }

  static fromSnapshot(snapshot: ClubCohortSnapshot): ClubCohort {
    return new ClubCohort({ ...snapshot });
  }

  get id(): string {
    return this.snapshot.id;
  }

  get clubId(): string {
    return this.snapshot.clubId;
  }

  get revisionNumber(): number {
    return this.snapshot.revisionNumber;
  }

  toSnapshot(): ClubCohortSnapshot {
    return { ...this.snapshot };
  }

  /**
   * 重命名届次：改名留 revisionNumber+1、updatedAt 更新并记录操作者；
   * 只影响 name，academicYearName 保持不变（换届须新建届次，
   * CFG-003：切换学年不自动执行换届）。
   */
  rename(newName: string, context: { by: string; now: Date }): void {
    this.snapshot = {
      ...this.snapshot,
      name: validateCohortName(newName),
      revisionNumber: this.snapshot.revisionNumber + 1,
      updatedAt: context.now,
      updatedBy: context.by,
    };
  }

  /** 写命令前校验届次归属社团，不符抛 CFG_FORBIDDEN（越社操作在领域层拒绝） */
  assertSameClub(clubId: string): void {
    if (this.snapshot.clubId !== clubId) {
      throw new ConfigDomainError('CFG_FORBIDDEN', '届次不属于该社团', {
        expectedClubId: this.snapshot.clubId,
        actualClubId: clubId,
      });
    }
  }
}
