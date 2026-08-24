/**
 * config 应用层测试桩（spec 共用；不用于生产）。
 *
 * - InMemoryClubProfileRepository：Map 存储，save 直接覆盖（无版本守卫，
 *   乐观锁由用例层 expectedVersion 检查承担）；
 * - StubConfigAuthorization：可编程管理身份，默认 null（fail-closed 无权）；
 * - StubClubMembershipPort：可编程成员集合；
 * - StubClubAccessInfoPort：可编程 Casdoor Group 对应关系（默认 null）。
 */

import { ConfigDomainError } from '../../domain/errors';
import type { ClubProfileSnapshot } from '../../domain/models/club-profile';
import type {
  ClubProfileRepositoryPort,
  ClubProfileAuthorizationPort,
  ClubMembershipPort,
  ClubAccessInfoPort,
  ClubProfileManageRole,
} from '../ports';

export class InMemoryClubProfileRepository implements ClubProfileRepositoryPort {
  private readonly profiles = new Map<string, ClubProfileSnapshot>();

  async load(clubId: string): Promise<ClubProfileSnapshot | null> {
    return this.profiles.get(clubId) ?? null;
  }
  async save(
    snapshot: ClubProfileSnapshot,
    guard?: { readonly expectedPreviousRevision: number },
  ): Promise<void> {
    const stored = this.profiles.get(snapshot.clubId);
    if (guard && (stored?.revisionNumber ?? null) !== guard.expectedPreviousRevision) {
      // 与 PostgreSQL 实现同语义：条件更新零行即版本冲突
      throw new ConfigDomainError(
        'CFG_VERSION_CONFLICT',
        '展示资料已被他人修改（持久层乐观锁拒绝写入）',
      );
    }
    this.profiles.set(snapshot.clubId, snapshot);
  }
}

export class StubConfigAuthorization implements ClubProfileAuthorizationPort {
  /** 'OWNER'=负责人/人事；'PLATFORM'=平台超管代改；null=无权（默认 fail-closed） */
  manageRole: ClubProfileManageRole | null = null;

  async canManageAs(_clubId: string, _subjectId: string): Promise<ClubProfileManageRole | null> {
    return this.manageRole;
  }
}

export class StubClubMembershipPort implements ClubMembershipPort {
  memberIds = new Set<string>();

  async isMember(_clubId: string, subjectId: string): Promise<boolean> {
    return this.memberIds.has(subjectId);
  }
}

export interface StubCasdoorGroupBinding {
  readonly casdoorGroupId: string;
  readonly casdoorGroupName: string;
}

export class StubClubAccessInfoPort implements ClubAccessInfoPort {
  /** null=组织模块未暴露绑定查询时的回显形态 */
  info: StubCasdoorGroupBinding | null = null;

  async getAccessInfo(_clubId: string): Promise<StubCasdoorGroupBinding | null> {
    return this.info;
  }
}

// --------------------------------------------------------------------------
// CFG-002/003 测试桩（作用域策略表/学年分界/届次）
// --------------------------------------------------------------------------

import type { ScopedPolicyTableSnapshot } from '../../domain/models/scoped-policy';
import type { ScopedPolicyTableRepositoryPort, PolicyAuthorizationPort } from '../ports';
import type {
  AcademicYearBoundaryRepositoryPort,
  AcademicYearSettingsSnapshot,
  CohortRepositoryPort,
} from '../ports';
import type { ClubCohortSnapshot } from '../../domain/models/club-cohort';

export class InMemoryScopedPolicyTableRepository implements ScopedPolicyTableRepositoryPort {
  snapshot: ScopedPolicyTableSnapshot | null = null;

  async load(): Promise<ScopedPolicyTableSnapshot | null> {
    return this.snapshot;
  }
  async save(snapshot: ScopedPolicyTableSnapshot): Promise<void> {
    this.snapshot = snapshot;
  }
}

export class StubPolicyAuthorization implements PolicyAuthorizationPort {
  platformAllowed = false;
  clubAllowed = false;

  async canManagePlatform(_subjectId: string): Promise<boolean> {
    return this.platformAllowed;
  }
  async canManageClub(_clubId: string, _subjectId: string): Promise<boolean> {
    return this.clubAllowed;
  }
}

export class InMemoryAcademicYearBoundaryRepository implements AcademicYearBoundaryRepositoryPort {
  snapshot: AcademicYearSettingsSnapshot | null = null;

  async load(): Promise<AcademicYearSettingsSnapshot | null> {
    return this.snapshot;
  }
  async save(snapshot: AcademicYearSettingsSnapshot): Promise<void> {
    this.snapshot = snapshot;
  }
}

export class InMemoryCohortRepository implements CohortRepositoryPort {
  private readonly cohorts = new Map<string, ClubCohortSnapshot>();

  async listByClub(clubId: string): Promise<ClubCohortSnapshot[]> {
    return [...this.cohorts.values()].filter((c) => c.clubId === clubId);
  }
  async findById(cohortId: string): Promise<ClubCohortSnapshot | null> {
    return this.cohorts.get(cohortId) ?? null;
  }
  async save(snapshot: ClubCohortSnapshot): Promise<void> {
    this.cohorts.set(snapshot.id, snapshot);
  }
}

// --------------------------------------------------------------------------
// CFG-004/005 测试桩（配置根版本线/字段映射草稿）
// --------------------------------------------------------------------------

import type { ConfigRootRepositoryPort, FieldMappingStateRepositoryPort } from '../ports';
import type { ConfigRootSnapshot } from '../../domain/models/config-version';
import type { FieldMappingDraftState } from '../../domain/models/field-mapping';

export class InMemoryConfigRootRepository implements ConfigRootRepositoryPort {
  private readonly roots = new Map<string, ConfigRootSnapshot>();

  async find(rootId: string): Promise<ConfigRootSnapshot | null> {
    return this.roots.get(rootId) ?? null;
  }
  async save(snapshot: ConfigRootSnapshot): Promise<void> {
    this.roots.set(snapshot.rootId, snapshot);
  }
}

export class InMemoryFieldMappingStateRepository implements FieldMappingStateRepositoryPort {
  state: FieldMappingDraftState | null = null;

  async load(): Promise<FieldMappingDraftState | null> {
    return this.state;
  }
  async save(state: FieldMappingDraftState): Promise<void> {
    this.state = state;
  }
}
