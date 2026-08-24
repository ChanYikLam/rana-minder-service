/**
 * config 模块 NestJS 装配（interfaces/nest + application + infrastructure）。
 *
 * 职责（5.5 配置平台；当前接入 5.5.1 社团展示资料 CFG-001）：
 * - 展示资料与接入信息分离：Casdoor Group ID/绑定关系/原始 Group 名称归组织模块
 *   （仅超管管理），本模块只保存展示名称/Logo/简介/联系方式/招新说明并回显对应
 *   关系（accessInfo 未接线前为 null）；
 * - 修改立即生效、无需审批，逐次留痕（旧值/新值/修改人/onBehalf）；每个联系方式
 *   字段强制选择可见范围；公开投影结构性排除成员名单/部门关系/职位人员；
 * - 授权经 CURRENT_PERMISSIONS_PORT 逐请求重算（ORG-038）：club:config:manage →
 *   'OWNER'，平台超管 → 'PLATFORM'（代改），否则拒绝（fail-closed）。
 *
 * 会话：identity AUTH_SESSION_PROVIDER 经 adaptSessionProvider 适配（未认证 401，
 * fail-closed）。仓储：PostgreSQL 权威实现（迁移 20260824000000，与仓储单源一致；
 * DB 适配未接线时 fail-closed）。InMemory 实现保留于 testing/ 供单元测试直用。
 */

import { Module } from '@nestjs/common';

import { AdaptersModule } from '../../adapters/adapters.module';
import { ObservabilityModule } from '../../platform/observability/module';
import { OrganizationModule } from '../organization/module';
import { IdentityModule } from '../identity/identity.module';
import { AUTH_SESSION_PROVIDER } from '../identity/tokens';
import { adaptSessionProvider } from '../../shared/adapt-session-provider';
import { CURRENT_PERMISSIONS_PORT } from '../organization/application/ports';

import {
  CONFIG_REPOSITORY,
  CONFIG_AUTHORIZATION,
  CONFIG_MEMBERSHIP_PORT,
  CONFIG_ACCESS_INFO_PORT,
  CONFIG_AUTH_SESSION_PROVIDER,
  UPDATE_CLUB_PROFILE_COMMAND,
  GET_CLUB_PROFILE_QUERY,
  GET_PUBLIC_CLUB_PROFILE_QUERY,
  CONFIG_POLICY_AUTHORIZATION,
  SCOPED_POLICY_TABLE_REPOSITORY,
  ACADEMIC_YEAR_BOUNDARY_REPOSITORY,
  COHORT_REPOSITORY,
  SET_PLATFORM_POLICY_COMMAND,
  SET_CLUB_POLICY_COMMAND,
  FREEZE_ACTIVITY_POLICY_COMMAND,
  AMEND_ACTIVITY_POLICY_COMMAND,
  GET_RESOLVED_POLICIES_QUERY,
  UPDATE_ACADEMIC_YEAR_BOUNDARY_COMMAND,
  GET_CURRENT_ACADEMIC_YEAR_QUERY,
  CREATE_COHORT_COMMAND,
  RENAME_COHORT_COMMAND,
  LIST_COHORTS_QUERY,
  CONFIG_ROOT_REPOSITORY,
  FIELD_MAPPING_STATE_REPOSITORY,
  CREATE_CONFIG_DRAFT_COMMAND,
  EDIT_CONFIG_DRAFT_COMMAND,
  PUBLISH_CONFIG_VERSION_COMMAND,
  ROLLBACK_CONFIG_VERSION_COMMAND,
  GET_CONFIG_ROOT_QUERY,
  SAVE_FIELD_MAPPING_DRAFT_COMMAND,
  ACTIVATE_FIELD_MAPPING_REAL_DATA_COMMAND,
  PUBLISH_FIELD_MAPPING_COMMAND,
  GET_FIELD_MAPPING_QUERY,
  GET_PLATFORM_POLICIES_QUERY,
} from './tokens';

// InMemory 仓储保留在 testing/ 供单元测试直用；模块装配绑定 PostgreSQL 权威实现
import {
  OrgBackedConfigAuthorization,
  OrgBackedPolicyAuthorization,
  OrgBackedClubMembership,
  NotWiredClubAccessInfoPort,
} from './infrastructure/org-config-adapters';
import { ConfigUnitOfWork } from './infrastructure/unit-of-work';
import {
  PostgresClubProfileRepository,
  PostgresScopedPolicyTableRepository,
  PostgresAcademicYearBoundaryRepository,
  PostgresCohortRepository,
  PostgresConfigRootRepository,
  PostgresFieldMappingStateRepository,
} from './infrastructure/postgres.repositories';
import { DB_ADAPTER } from '../../adapters/tokens';

import { DefaultUpdateClubProfileCommand } from './application/commands/update-club-profile.command';
import { DefaultGetClubProfileQuery } from './application/queries/get-club-profile.query';
import { DefaultGetPublicClubProfileQuery } from './application/queries/get-public-club-profile.query';
import {
  SetPlatformPolicyCommand,
  SetClubPolicyCommand,
  FreezeActivityPolicyCommand,
  AmendActivityPolicyCommand,
} from './application/commands/policy.commands';
import { GetResolvedPoliciesQuery } from './application/queries/get-policies.query';
import {
  UpdateAcademicYearBoundaryCommand,
  GetCurrentAcademicYearQuery,
  CreateCohortCommand,
  RenameCohortCommand,
  ListCohortsQuery,
} from './application/commands/academic-year.commands';
import {
  CreateConfigDraftCommand,
  EditConfigDraftCommand,
  PublishConfigVersionCommand,
  RollbackConfigVersionCommand,
  GetConfigRootQuery,
} from './application/commands/config-version.commands';
import {
  SaveFieldMappingDraftCommand,
  ActivateFieldMappingRealDataCommand,
  PublishFieldMappingCommand,
  GetFieldMappingQuery,
} from './application/commands/field-mapping.commands';
import { GetPlatformPoliciesQuery } from './application/queries/get-policies.query';

import { ConfigAuthGuard } from './interfaces/nest/config-auth.guard';
import { PublicClubProfileNestController } from './interfaces/nest/public-club-profile.nest.controller';
import { OrgClubProfileNestController } from './interfaces/nest/org-club-profile.nest.controller';
import { AdminConfigNestController } from './interfaces/nest/admin-config.nest.controller';
import { OrgPolicyNestController } from './interfaces/nest/org-policy.nest.controller';

@Module({
  imports: [AdaptersModule, ObservabilityModule, OrganizationModule, IdentityModule],
  controllers: [
    PublicClubProfileNestController,
    OrgClubProfileNestController,
    AdminConfigNestController,
    OrgPolicyNestController,
  ],
  providers: [
    // ----- 会话（identity 链路适配；未认证 fail-closed 401）-----
    {
      provide: CONFIG_AUTH_SESSION_PROVIDER,
      useFactory: (identitySession) => adaptSessionProvider(identitySession),
      inject: [AUTH_SESSION_PROVIDER],
    },
    ConfigAuthGuard,
    // ----- 工作单元（事务边界）-----
    {
      provide: ConfigUnitOfWork,
      useFactory: (db) => new ConfigUnitOfWork(db),
      inject: [DB_ADAPTER],
    },
    // ----- PostgreSQL 权威仓储（迁移 20260824000000；单源一致）-----
    {
      provide: CONFIG_REPOSITORY,
      useFactory: (db, uow) => new PostgresClubProfileRepository(db, uow),
      inject: [DB_ADAPTER, ConfigUnitOfWork],
    },
    {
      provide: SCOPED_POLICY_TABLE_REPOSITORY,
      useFactory: (db, uow) => new PostgresScopedPolicyTableRepository(db, uow),
      inject: [DB_ADAPTER, ConfigUnitOfWork],
    },
    {
      provide: ACADEMIC_YEAR_BOUNDARY_REPOSITORY,
      useFactory: (db, uow) => new PostgresAcademicYearBoundaryRepository(db, uow),
      inject: [DB_ADAPTER, ConfigUnitOfWork],
    },
    {
      provide: COHORT_REPOSITORY,
      useFactory: (db, uow) => new PostgresCohortRepository(db, uow),
      inject: [DB_ADAPTER, ConfigUnitOfWork],
    },
    {
      provide: CONFIG_ROOT_REPOSITORY,
      useFactory: (db, uow) => new PostgresConfigRootRepository(db, uow),
      inject: [DB_ADAPTER, ConfigUnitOfWork],
    },
    {
      provide: FIELD_MAPPING_STATE_REPOSITORY,
      useFactory: (db, uow) => new PostgresFieldMappingStateRepository(db, uow),
      inject: [DB_ADAPTER, ConfigUnitOfWork],
    },
    // ----- 授权/成员资格（组织授权逐请求重算）/接入信息回显 -----
    {
      provide: CONFIG_AUTHORIZATION,
      useFactory: (permissions) => new OrgBackedConfigAuthorization(permissions),
      inject: [CURRENT_PERMISSIONS_PORT],
    },
    {
      provide: CONFIG_MEMBERSHIP_PORT,
      useFactory: (permissions) => new OrgBackedClubMembership(permissions),
      inject: [CURRENT_PERMISSIONS_PORT],
    },
    { provide: CONFIG_ACCESS_INFO_PORT, useClass: NotWiredClubAccessInfoPort },
    // ----- 应用命令/查询 -----
    {
      provide: UPDATE_CLUB_PROFILE_COMMAND,
      useFactory: (repo, authz) => new DefaultUpdateClubProfileCommand(repo, authz),
      inject: [CONFIG_REPOSITORY, CONFIG_AUTHORIZATION],
    },
    {
      provide: GET_CLUB_PROFILE_QUERY,
      useFactory: (repo, authz, accessInfo) =>
        new DefaultGetClubProfileQuery(repo, authz, accessInfo),
      inject: [CONFIG_REPOSITORY, CONFIG_AUTHORIZATION, CONFIG_ACCESS_INFO_PORT],
    },
    {
      provide: GET_PUBLIC_CLUB_PROFILE_QUERY,
      useFactory: (repo, membership) => new DefaultGetPublicClubProfileQuery(repo, membership),
      inject: [CONFIG_REPOSITORY, CONFIG_MEMBERSHIP_PORT],
    },
    // ----- CFG-002 作用域策略（平台默认值/社团覆盖/活动快照）-----
    {
      provide: CONFIG_POLICY_AUTHORIZATION,
      useFactory: (permissions) => new OrgBackedPolicyAuthorization(permissions),
      inject: [CURRENT_PERMISSIONS_PORT],
    },
    {
      provide: SET_PLATFORM_POLICY_COMMAND,
      useFactory: (repo, authz) => new SetPlatformPolicyCommand(repo, authz),
      inject: [SCOPED_POLICY_TABLE_REPOSITORY, CONFIG_POLICY_AUTHORIZATION],
    },
    {
      provide: SET_CLUB_POLICY_COMMAND,
      useFactory: (repo, authz) => new SetClubPolicyCommand(repo, authz),
      inject: [SCOPED_POLICY_TABLE_REPOSITORY, CONFIG_POLICY_AUTHORIZATION],
    },
    {
      provide: FREEZE_ACTIVITY_POLICY_COMMAND,
      useFactory: (repo) => new FreezeActivityPolicyCommand(repo),
      inject: [SCOPED_POLICY_TABLE_REPOSITORY],
    },
    { provide: AMEND_ACTIVITY_POLICY_COMMAND, useClass: AmendActivityPolicyCommand },
    {
      provide: GET_RESOLVED_POLICIES_QUERY,
      useFactory: (repo) => new GetResolvedPoliciesQuery(repo),
      inject: [SCOPED_POLICY_TABLE_REPOSITORY],
    },
    // ----- CFG-003 学年与届次 -----
    {
      provide: UPDATE_ACADEMIC_YEAR_BOUNDARY_COMMAND,
      useFactory: (repo, authz) => new UpdateAcademicYearBoundaryCommand(repo, authz),
      inject: [ACADEMIC_YEAR_BOUNDARY_REPOSITORY, CONFIG_POLICY_AUTHORIZATION],
    },
    {
      provide: GET_CURRENT_ACADEMIC_YEAR_QUERY,
      useFactory: (repo) => new GetCurrentAcademicYearQuery(repo),
      inject: [ACADEMIC_YEAR_BOUNDARY_REPOSITORY],
    },
    {
      provide: CREATE_COHORT_COMMAND,
      useFactory: (cohorts, boundaryRepo, authz) =>
        new CreateCohortCommand(cohorts, boundaryRepo, authz),
      inject: [COHORT_REPOSITORY, ACADEMIC_YEAR_BOUNDARY_REPOSITORY, CONFIG_POLICY_AUTHORIZATION],
    },
    {
      provide: RENAME_COHORT_COMMAND,
      useFactory: (cohorts, authz) => new RenameCohortCommand(cohorts, authz),
      inject: [COHORT_REPOSITORY, CONFIG_POLICY_AUTHORIZATION],
    },
    {
      provide: LIST_COHORTS_QUERY,
      useFactory: (cohorts) => new ListCohortsQuery(cohorts),
      inject: [COHORT_REPOSITORY],
    },
    // ----- CFG-002 平台策略查询 -----
    {
      provide: GET_PLATFORM_POLICIES_QUERY,
      useFactory: (repo) => new GetPlatformPoliciesQuery(repo),
      inject: [SCOPED_POLICY_TABLE_REPOSITORY],
    },
    // ----- CFG-004 Casdoor 字段映射 -----
    {
      provide: SAVE_FIELD_MAPPING_DRAFT_COMMAND,
      useFactory: (states, authz) => new SaveFieldMappingDraftCommand(states, authz),
      inject: [FIELD_MAPPING_STATE_REPOSITORY, CONFIG_POLICY_AUTHORIZATION],
    },
    {
      provide: ACTIVATE_FIELD_MAPPING_REAL_DATA_COMMAND,
      useFactory: (states, authz) => new ActivateFieldMappingRealDataCommand(states, authz),
      inject: [FIELD_MAPPING_STATE_REPOSITORY, CONFIG_POLICY_AUTHORIZATION],
    },
    {
      provide: PUBLISH_FIELD_MAPPING_COMMAND,
      useFactory: (states, roots, authz) => new PublishFieldMappingCommand(states, roots, authz),
      inject: [FIELD_MAPPING_STATE_REPOSITORY, CONFIG_ROOT_REPOSITORY, CONFIG_POLICY_AUTHORIZATION],
    },
    {
      provide: GET_FIELD_MAPPING_QUERY,
      useFactory: (states, authz) => new GetFieldMappingQuery(states, authz),
      inject: [FIELD_MAPPING_STATE_REPOSITORY, CONFIG_POLICY_AUTHORIZATION],
    },
    // ----- CFG-005 配置版本线 -----
    {
      provide: CREATE_CONFIG_DRAFT_COMMAND,
      useFactory: (roots, authz) => new CreateConfigDraftCommand(roots, authz),
      inject: [CONFIG_ROOT_REPOSITORY, CONFIG_POLICY_AUTHORIZATION],
    },
    {
      provide: EDIT_CONFIG_DRAFT_COMMAND,
      useFactory: (roots, authz) => new EditConfigDraftCommand(roots, authz),
      inject: [CONFIG_ROOT_REPOSITORY, CONFIG_POLICY_AUTHORIZATION],
    },
    {
      provide: PUBLISH_CONFIG_VERSION_COMMAND,
      useFactory: (roots, authz) => new PublishConfigVersionCommand(roots, authz),
      inject: [CONFIG_ROOT_REPOSITORY, CONFIG_POLICY_AUTHORIZATION],
    },
    {
      provide: ROLLBACK_CONFIG_VERSION_COMMAND,
      useFactory: (roots, authz) => new RollbackConfigVersionCommand(roots, authz),
      inject: [CONFIG_ROOT_REPOSITORY, CONFIG_POLICY_AUTHORIZATION],
    },
    {
      provide: GET_CONFIG_ROOT_QUERY,
      useFactory: (roots, authz) => new GetConfigRootQuery(roots, authz),
      inject: [CONFIG_ROOT_REPOSITORY, CONFIG_POLICY_AUTHORIZATION],
    },
  ],
  exports: [
    UPDATE_CLUB_PROFILE_COMMAND,
    GET_CLUB_PROFILE_QUERY,
    GET_PUBLIC_CLUB_PROFILE_QUERY,
    CONFIG_REPOSITORY,
    CONFIG_AUTH_SESSION_PROVIDER,
    SET_PLATFORM_POLICY_COMMAND,
    SET_CLUB_POLICY_COMMAND,
    FREEZE_ACTIVITY_POLICY_COMMAND,
    AMEND_ACTIVITY_POLICY_COMMAND,
    GET_RESOLVED_POLICIES_QUERY,
    GET_CURRENT_ACADEMIC_YEAR_QUERY,
    LIST_COHORTS_QUERY,
  ],
})
export class ConfigModule {}
