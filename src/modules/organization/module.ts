/**
 * 领域模块 · 组织与授权（ADR-002 §2.1；SRS-SM-ORG-001~004；#68 端口接线）。
 *
 * 装配策略（fail-closed 开关，GOV-007/#68 验收红线）：
 * - 默认（开发/测试）：infrastructure/in-memory 可配置桩；全部桩在
 *   NODE_ENV=production 下构造即抛错（assertMemoryStubAllowed），生产不可能
 *   带内存态对外服务。
 * - ORG_DB_REAL=1：五个聚合仓储切换 PostgreSQL 实现（DB_ADAPTER，ADR-014）。
 * - ORG_CASDOOR_REAL=1：CasdoorGroupPort 切换 HTTP 适配器（写后定向读回，
 *   CAS-WR-*）；端点形态须按部署实例核对后方可开启。
 * - ORG_JOBS_PLATFORM=1：JobSchedulerPort 桥接 platform/tasks TaskRepository
 *   （持久任务与单执行租约，ADR-004），此时模块追加导入 TasksModule。
 * - ORG_NOTIFY_CHANNEL=1：NotificationPort 经 ADAPTERS_NOTIFY 外部渠道附加投递
 *   （IFC-TX-005：渠道失败不阻断主事务）。
 * - ReconcilePort 一律使用真实对账服务（GroupReconcileService）：检测绑定
 *   Group 的删除/失权/移动，开发态跑在内存 Casdoor 桩上同样生效。
 *
 * CurrentPermissionsPort：身份鉴权（identity）接线为后续任务；在此之前生产
 * 构造 MemoryCurrentPermissionsPort 会被守卫拒绝（fail-closed），不会静默放行。
 */

import { forwardRef, Module } from '@nestjs/common';

import { AdminClubsQuery } from './application/queries/admin-clubs.query';
import { GroupDirectoryQuery } from './application/queries/admin-clubs.query';
import { PermissionTemplateQuery } from './application/queries/permission-template.query';
import { OrgContextQuery } from './application/queries/org-context.query';

import { appointmentCommandProvider } from './application/commands/appointment-command.use-case';
import { onboardingProvider } from './application/commands/onboard-club.use-case';
import { clubLifecycleProvider } from './application/commands/club-lifecycle.use-case';
import { relationCommandProvider } from './application/commands/relation-command.use-case';
import { permissionTemplateCommandProvider } from './application/commands/permission-template.command';
import { controlledBatchProvider } from './application/commands/controlled-batch.use-case';
import { GroupReconcileService } from './application/group-reconcile.service';

import {
  CASDOOR_GROUP_PORT,
  CLOCK,
  CLUB_STORE,
  CURRENT_PERMISSIONS_PORT,
  GROUP_MAPPING_REGISTRY,
  JOB_SCHEDULER,
  NOTIFICATION_PORT,
  RECONCILE_PORT,
  PERMISSION_TEMPLATE_STORE,
  RELATION_COMMAND_STORE,
  RELATION_COMMAND_AUDIT_PORT,
  APPOINTMENT_COMMAND_STORE,
  ADMIN_CLUBS_QUERY,
  GROUP_DIRECTORY_QUERY,
  PERMISSION_TEMPLATE_QUERY,
  ORG_CONTEXT_QUERY,
  type CasdoorGroupPort,
  type ClubStore,
  type CurrentPermissionsPort,
  type GroupMappingRegistry,
  type PermissionTemplateStore,
} from './application/ports';

// 真实基础设施（#68）
import { ADAPTERS_NOTIFY, DB_ADAPTER } from '../../adapters/tokens';
import {
  RANA_MINDER_CONFIG,
  isSecretRef,
  resolveSecret,
  type RanaMinderConfig,
} from '../../config';
import type { DbAdapter } from '../../shared/db-adapter';
import type { NotifyAdapter } from '../../adapters/notify/external-notify.adapter';
import { OrgUnitOfWork } from './infrastructure/postgres/org-unit-of-work';
import { PostgresClubStore } from './infrastructure/postgres/postgres-club.store';
import {
  PostgresAppointmentCommandStore,
  PostgresRelationCommandStore,
} from './infrastructure/postgres/postgres-command.stores';
import {
  PostgresGroupMappingRegistry,
  PostgresPermissionTemplateStore,
} from './infrastructure/postgres/postgres-config.stores';
import { HttpCasdoorGroupAdapter } from './infrastructure/http/http-casdoor-group.adapter';
import { TaskRepositoryJobScheduler } from './infrastructure/task-repository.scheduler';
import { NotifyChannelNotificationPort } from './infrastructure/notify-channel.notification-port';
import { TASK_REPOSITORY, type TaskRepository } from '../../platform/tasks/contracts';
import { TasksModule } from '../../platform/tasks/module';

// 内存桩（仅非生产可用；构造期由 GOV-007 守卫拒绝）
import {
  InMemoryAppointmentCommandStore,
  InMemoryCasdoorPort,
  InMemoryClubStore,
  InMemoryGroupMappingRegistry,
  InMemoryJobScheduler,
  InMemoryNotificationPort,
  InMemoryPermissionTemplateStore,
  InMemoryRelationCommandStore,
  InMemoryRelationCommandAuditStore,
  MemoryCurrentPermissionsPort,
  SystemClock,
} from './infrastructure/in-memory/memory-implementations';
import { DEMO_CASDOOR_SEED } from './infrastructure/in-memory/demo-seed';

import { AdminClubsController } from './interfaces/controllers/admin-clubs.controller';
import { AdminPermissionTemplatesController } from './interfaces/controllers/admin-permission-templates.controller';
import { OrgWorkspaceController } from './interfaces/controllers/org-workspace.controller';

/** fail-closed 装配开关（与 adapters 模块 ADAPTERS_*_REAL 同口径） */
export function orgDbRealEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env['ORG_DB_REAL'] === '1';
}
export function orgCasdoorRealEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env['ORG_CASDOOR_REAL'] === '1';
}
export function orgJobsPlatformEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env['ORG_JOBS_PLATFORM'] === '1';
}
export function orgNotifyChannelEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env['ORG_NOTIFY_CHANNEL'] === '1';
}

const USE_PG = orgDbRealEnabled();
const USE_HTTP_CASDOOR = orgCasdoorRealEnabled();
const USE_PLATFORM_JOBS = orgJobsPlatformEnabled();
const USE_NOTIFY_CHANNEL = orgNotifyChannelEnabled();

/** PG 聚合仓储共享的工作单元（仅 ORG_DB_REAL=1 时装配） */
export const ORG_UNIT_OF_WORK = Symbol('ORG_UNIT_OF_WORK');

const OrgUnitOfWorkProvider = {
  provide: ORG_UNIT_OF_WORK,
  useFactory: (db: DbAdapter) => new OrgUnitOfWork(db),
  inject: [DB_ADAPTER],
};

@Module({
  // forwardRef：TasksModule→NotificationModule→OrganizationModule 存在既有引用环，
  // 平台调度桥仅在 ORG_JOBS_PLATFORM=1 时按需接入（见文件头装配策略）
  imports: [...(USE_PLATFORM_JOBS ? [forwardRef(() => TasksModule)] : [])],
  controllers: [AdminClubsController, AdminPermissionTemplatesController, OrgWorkspaceController],
  providers: [
    { provide: CLOCK, useFactory: () => new SystemClock() },
    // ---- CasdoorGroupPort ----
    ...(USE_HTTP_CASDOOR
      ? [
          {
            provide: CASDOOR_GROUP_PORT,
            useFactory: (config: RanaMinderConfig) => {
              const casdoor = config.casdoor;
              const clientSecret = isSecretRef(casdoor.clientSecretRef)
                ? resolveSecret(casdoor.clientSecretRef)
                : casdoor.clientSecretRef;
              return new HttpCasdoorGroupAdapter({
                endpoint: casdoor.endpoint,
                clientId: casdoor.clientId,
                organization: casdoor.organization,
                clientSecret,
              });
            },
            inject: [RANA_MINDER_CONFIG],
          },
        ]
      : [
          {
            provide: CASDOOR_GROUP_PORT,
            useFactory: () => new InMemoryCasdoorPort(DEMO_CASDOOR_SEED),
          },
        ]),
    // ---- 聚合仓储 ----
    ...(USE_PG
      ? [
          OrgUnitOfWorkProvider,
          {
            provide: CLUB_STORE,
            useFactory: (db: DbAdapter, uow: OrgUnitOfWork) => new PostgresClubStore(db, uow),
            inject: [DB_ADAPTER, ORG_UNIT_OF_WORK],
          },
          {
            provide: RELATION_COMMAND_STORE,
            useFactory: (db: DbAdapter, uow: OrgUnitOfWork) =>
              new PostgresRelationCommandStore(db, uow),
            inject: [DB_ADAPTER, ORG_UNIT_OF_WORK],
          },
          {
            provide: APPOINTMENT_COMMAND_STORE,
            useFactory: (db: DbAdapter, uow: OrgUnitOfWork) =>
              new PostgresAppointmentCommandStore(db, uow),
            inject: [DB_ADAPTER, ORG_UNIT_OF_WORK],
          },
          {
            provide: PERMISSION_TEMPLATE_STORE,
            useFactory: (db: DbAdapter, uow: OrgUnitOfWork) =>
              new PostgresPermissionTemplateStore(db, uow),
            inject: [DB_ADAPTER, ORG_UNIT_OF_WORK],
          },
          {
            provide: GROUP_MAPPING_REGISTRY,
            useFactory: (db: DbAdapter, uow: OrgUnitOfWork) =>
              new PostgresGroupMappingRegistry(db, uow),
            inject: [DB_ADAPTER, ORG_UNIT_OF_WORK],
          },
        ]
      : [
          { provide: CLUB_STORE, useFactory: () => new InMemoryClubStore() },
          { provide: RELATION_COMMAND_STORE, useFactory: () => new InMemoryRelationCommandStore() },
          {
            provide: APPOINTMENT_COMMAND_STORE,
            useFactory: () => new InMemoryAppointmentCommandStore(),
          },
          {
            provide: PERMISSION_TEMPLATE_STORE,
            useFactory: () => new InMemoryPermissionTemplateStore(),
          },
          { provide: GROUP_MAPPING_REGISTRY, useFactory: () => new InMemoryGroupMappingRegistry() },
        ]),
    // ---- 关系命令审计（RelationCommandAuditPort：暂无 PG 实现，内存态无条件装配）----
    {
      provide: RELATION_COMMAND_AUDIT_PORT,
      useFactory: () => new InMemoryRelationCommandAuditStore(),
    },
    // ---- 对账（真实检测逻辑，跑在任意 CasdoorGroupPort 上）----
    {
      provide: RECONCILE_PORT,
      useFactory: (clubs: ClubStore, casdoor: CasdoorGroupPort, registry: GroupMappingRegistry) =>
        new GroupReconcileService({ clubs, casdoor, registry }),
      inject: [CLUB_STORE, CASDOOR_GROUP_PORT, GROUP_MAPPING_REGISTRY],
    },
    // ---- Job 调度 ----
    ...(USE_PLATFORM_JOBS
      ? [
          {
            provide: JOB_SCHEDULER,
            useFactory: (tasks: TaskRepository) => new TaskRepositoryJobScheduler(tasks),
            inject: [TASK_REPOSITORY],
          },
        ]
      : [{ provide: JOB_SCHEDULER, useFactory: () => new InMemoryJobScheduler() }]),
    // ---- 通知 ----
    ...(USE_NOTIFY_CHANNEL
      ? [
          {
            provide: NOTIFICATION_PORT,
            useFactory: (channel: NotifyAdapter) => new NotifyChannelNotificationPort(channel),
            inject: [ADAPTERS_NOTIFY],
          },
        ]
      : [{ provide: NOTIFICATION_PORT, useFactory: () => new InMemoryNotificationPort() }]),
    // ---- 当前权限（identity 接线为后续任务；生产由 GOV-007 守卫拒绝内存桩）----
    {
      provide: CURRENT_PERMISSIONS_PORT,
      useFactory: () =>
        new MemoryCurrentPermissionsPort({
          superAdminUsers: ['u_root'],
          clubPermissions: new Map([['club-acm-1', ['club:member:manage']]]),
          positionGroupMemberships: new Map([
            [
              'u_a',
              [
                {
                  group: { owner: 'club-acm', name: '负责人组' },
                  clubId: 'club-acm-1',
                  departmentId: null,
                },
              ],
            ],
            [
              'u_b',
              [
                {
                  group: { owner: 'club-acm', name: '人事组' },
                  clubId: 'club-acm-1',
                  departmentId: null,
                },
              ],
            ],
            [
              'u_c',
              [
                {
                  group: { owner: 'club-acm', name: '宣传部' },
                  clubId: 'club-acm-1',
                  departmentId: 'dept-pr',
                },
              ],
            ],
          ]),
        }),
    },
    onboardingProvider,
    clubLifecycleProvider,
    relationCommandProvider,
    appointmentCommandProvider,
    permissionTemplateCommandProvider,
    controlledBatchProvider,
    {
      provide: ADMIN_CLUBS_QUERY,
      useFactory: (clubs: ClubStore, registry: GroupMappingRegistry, casdoor: CasdoorGroupPort) =>
        new AdminClubsQuery(clubs, registry, casdoor),
      inject: [CLUB_STORE, GROUP_MAPPING_REGISTRY, CASDOOR_GROUP_PORT],
    },
    {
      provide: GROUP_DIRECTORY_QUERY,
      useFactory: (casdoor: CasdoorGroupPort, registry: GroupMappingRegistry) =>
        new GroupDirectoryQuery(casdoor, registry),
      inject: [CASDOOR_GROUP_PORT, GROUP_MAPPING_REGISTRY],
    },
    {
      provide: PERMISSION_TEMPLATE_QUERY,
      useFactory: (store: PermissionTemplateStore) => new PermissionTemplateQuery(store),
      inject: [PERMISSION_TEMPLATE_STORE],
    },
    {
      provide: ORG_CONTEXT_QUERY,
      useFactory: (clubs: ClubStore, permissions: CurrentPermissionsPort) =>
        new OrgContextQuery(clubs, permissions),
      inject: [CLUB_STORE, CURRENT_PERMISSIONS_PORT],
    },
  ],
  exports: [
    CLOCK,
    CASDOOR_GROUP_PORT,
    CLUB_STORE,
    CURRENT_PERMISSIONS_PORT,
    JOB_SCHEDULER,
    NOTIFICATION_PORT,
    GROUP_MAPPING_REGISTRY,
    PERMISSION_TEMPLATE_STORE,
  ],
})
export class OrganizationModule {}
