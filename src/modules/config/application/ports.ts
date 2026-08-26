/**
 * config 应用层端口（CFG-001，5.5.1；依赖倒置边界）。
 *
 * - ClubProfileRepositoryPort：展示资料聚合持久化（当前 InMemory，PostgreSQL 仓储
 *   随 CFG-002~005 切片接入）；
 * - ClubProfileAuthorizationPort：管理授权判定，返回管理身份而非布尔——'OWNER'
 *   （负责人/人事，含 club:config:manage）或 'PLATFORM'（平台超管代改），null 即
 *   无权（fail-closed）。由实现方负责映射 PermissionCatalog 与超管判定，用例据此
 *   推导 onBehalf 留痕语义，不采纳请求方自报的「代改」声明；
 * - ClubMembershipPort：社团成员资格判定（公开投影三级可见范围用）；
 * - ClubAccessInfoPort：Casdoor Group 绑定对应关系查询（超管后台展示「展示名↔Group
 *   名」对照；接入信息归组织模块，本模块只读回显、不保存）。
 *
 * DI token 字符串常量统一定义在 ../tokens.ts（与 recruitment 模块约定一致）。
 */

import type { ClubProfileSnapshot } from '../domain/models/club-profile';
import type { RlsScope } from '../../../shared/db-adapter';

/**
 * 命令层事务包装端口（CFG-005 并发保护）：配置版本线写命令在单一事务窗口内
 * 执行「加锁读→改聚合→save」，findForUpdate 行锁须持至整个窗口结束。
 * 实现注入 ConfigUnitOfWork（已有外层事务则复用，否则自开并在命令完成后提交）。
 */
export interface CommandTransactionPort {
  runShared<T>(scope: RlsScope, fn: () => Promise<T>): Promise<T>;
}

/** 展示资料仓储端口：按社团 ID 存取聚合快照 */
export interface ClubProfileRepositoryPort {
  load(clubId: string): Promise<ClubProfileSnapshot | null>;
  /**
   * 保存聚合快照。guard.expectedPreviousRevision 提供时为条件更新（持久层
   * 乐观锁：库中当前修订号必须等于期望前值，否则拒绝写入并抛
   * CFG_VERSION_CONFLICT），防止「读-改-写」窗口内的并发丢失更新；
   * 缺省（首次初始化）为无条件 upsert。
   */
  save(
    snapshot: ClubProfileSnapshot,
    guard?: { readonly expectedPreviousRevision: number },
  ): Promise<void>;
}

/** 管理身份：OWNER=负责人/人事本人修改；PLATFORM=平台超管代改 */
export type ClubProfileManageRole = 'OWNER' | 'PLATFORM';

export interface ClubProfileAuthorizationPort {
  /** 返回主体对该社团展示资料的管理身份；无权返回 null（不抛错，由用例转 CFG_FORBIDDEN） */
  canManageAs(clubId: string, subjectId: string): Promise<ClubProfileManageRole | null>;
}

export interface ClubMembershipPort {
  isMember(clubId: string, subjectId: string): Promise<boolean>;
}

/** Casdoor Group 绑定对应关系（只读回显）；组织模块暴露绑定查询前恒为 null */
export interface ClubAccessInfoPort {
  getAccessInfo(clubId: string): Promise<{
    casdoorGroupId: string;
    casdoorGroupName: string;
  } | null>;
}

// --------------------------------------------------------------------------
// CFG-002 作用域策略 / CFG-003 学年与届次 端口
// --------------------------------------------------------------------------

/**
 * 配置授权端口（CFG-002/003；ORG-038 逐请求重算）：
 * - canManagePlatform：平台策略/学年分界规则维护（platform:config:manage 或平台超管）；
 * - canManageClub：社团默认值/届次维护（club:config:manage，即负责人/人事）。
 * 实现方映射 PermissionCatalog 与超管判定；用例 fail-closed。
 */
export interface PolicyAuthorizationPort {
  canManagePlatform(subjectId: string): Promise<boolean>;
  canManageClub(clubId: string, subjectId: string): Promise<boolean>;
}

/** 作用域策略表仓储（全系统单例表；当前 InMemory，PostgreSQL 随迁移切片接入） */
export interface ScopedPolicyTableRepositoryPort {
  load(): Promise<import('../domain/models/scoped-policy').ScopedPolicyTableSnapshot | null>;
  save(snapshot: import('../domain/models/scoped-policy').ScopedPolicyTableSnapshot): Promise<void>;
}

/** 学年分界规则与已生成学年注册（CFG-003；平台级单例） */
export interface AcademicYearSettingsSnapshot {
  readonly boundary: import('../domain/models/academic-year').AcademicYearBoundary;
  /** 已生成并落定的学年快照（历史学年保护的对象） */
  readonly generatedYears: readonly import('../domain/models/academic-year').AcademicYearSnapshot[];
  /** 分界规则最近一次修改留痕（CFG-003：变更须审计） */
  readonly lastChangedBy: string | null;
  readonly lastChangedAt: Date | null;
}

export interface AcademicYearBoundaryRepositoryPort {
  load(): Promise<AcademicYearSettingsSnapshot | null>;
  save(snapshot: AcademicYearSettingsSnapshot): Promise<void>;
}

/** 社团届次仓储（CFG-003：届次由负责人/人事维护并关联系统学年） */
export interface CohortRepositoryPort {
  listByClub(clubId: string): Promise<import('../domain/models/club-cohort').ClubCohortSnapshot[]>;
  findById(
    cohortId: string,
  ): Promise<import('../domain/models/club-cohort').ClubCohortSnapshot | null>;
  save(snapshot: import('../domain/models/club-cohort').ClubCohortSnapshot): Promise<void>;
}

// --------------------------------------------------------------------------
// CFG-005 配置版本线 / CFG-004 字段映射草稿 端口
// --------------------------------------------------------------------------

/** 配置根仓储（一个 rootId 一条版本线；当前 InMemory，PostgreSQL 随迁移切片接入） */
export interface ConfigRootRepositoryPort {
  find(
    rootId: string,
  ): Promise<import('../domain/models/config-version').ConfigRootSnapshot | null>;
  /**
   * 加锁读根（CFG-005 并发发布保护）：在活动事务内对根行加行锁，串行化
   * 「读-改-写」窗口内的并发建草稿/发布/回滚，防止版本号竞态与指针覆盖。
   * 事务外调用退化为普通读（无锁语义）；根不存在返回 null。
   * 并发首建（根缺失）说明：save 为 ON CONFLICT DO UPDATE（upsert），不抛唯一
   * 约束；首建是一次性引导操作、两路 v1 等价时结果收敛，聚合级 lost-update
   * 窗口实际风险低（评审 info）。
   */
  findForUpdate(
    rootId: string,
  ): Promise<import('../domain/models/config-version').ConfigRootSnapshot | null>;
  save(snapshot: import('../domain/models/config-version').ConfigRootSnapshot): Promise<void>;
}

/** Casdoor 字段映射编辑态仓储（平台级单例草稿；CFG-004） */
export interface FieldMappingStateRepositoryPort {
  load(): Promise<import('../domain/models/field-mapping').FieldMappingDraftState | null>;
  save(state: import('../domain/models/field-mapping').FieldMappingDraftState): Promise<void>;
}
