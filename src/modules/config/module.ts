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
 * fail-closed）。仓储：InMemoryClubProfileRepository（PostgreSQL 仓储随后续切片接
 * 入）。后续 CFG-002~005（默认值/学年届次/字段映射/版本发布）应用层在本模块追加。
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
} from './tokens';

import { InMemoryClubProfileRepository } from './application/testing/config-test-support';
import {
  OrgBackedConfigAuthorization,
  OrgBackedClubMembership,
  NotWiredClubAccessInfoPort,
} from './infrastructure/org-config-adapters';

import { DefaultUpdateClubProfileCommand } from './application/commands/update-club-profile.command';
import { DefaultGetClubProfileQuery } from './application/queries/get-club-profile.query';
import { DefaultGetPublicClubProfileQuery } from './application/queries/get-public-club-profile.query';

import { ConfigAuthGuard } from './interfaces/nest/config-auth.guard';
import { PublicClubProfileNestController } from './interfaces/nest/public-club-profile.nest.controller';
import { OrgClubProfileNestController } from './interfaces/nest/org-club-profile.nest.controller';

@Module({
  imports: [AdaptersModule, ObservabilityModule, OrganizationModule, IdentityModule],
  controllers: [PublicClubProfileNestController, OrgClubProfileNestController],
  providers: [
    // ----- 会话（identity 链路适配；未认证 fail-closed 401）-----
    {
      provide: CONFIG_AUTH_SESSION_PROVIDER,
      useFactory: (identitySession) => adaptSessionProvider(identitySession),
      inject: [AUTH_SESSION_PROVIDER],
    },
    ConfigAuthGuard,
    // ----- 仓储（InMemory；PostgreSQL 实现随 CFG-002~005 切片接入）-----
    { provide: CONFIG_REPOSITORY, useClass: InMemoryClubProfileRepository },
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
  ],
  exports: [
    UPDATE_CLUB_PROFILE_COMMAND,
    GET_CLUB_PROFILE_QUERY,
    GET_PUBLIC_CLUB_PROFILE_QUERY,
    CONFIG_REPOSITORY,
    CONFIG_AUTH_SESSION_PROVIDER,
  ],
})
export class ConfigModule {}
