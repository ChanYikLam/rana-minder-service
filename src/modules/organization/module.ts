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
 * 已知取舍（评审④声明）：RELATION_COMMAND_AUDIT_PORT 的 PG 审计仓储尚未实现——
 * 真实 DB 分支下非生产以内存审计降级（重启即丢），生产 fail-fast 禁止启动；
 * PG 审计仓储落地后移除该缺口。
 *
 * 装配校验时机（评审⑤/info①）：ORG_*_REAL 分支在模块加载期按当时进程环境
 * 一次性冻结；assertOrgRealWiring 不再于 import 期抛错，延迟到 DI 编译/启动
 * （providers 首位 ORG_WIRING_VALIDATION）以加载期快照求值——静态 import 本
 * 模块不会因 shell 误导出而崩溃，误配在装配入口干净失败。
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

/**
 * 分支在模块加载期按当时的进程环境一次性冻结（静态 @Module 装配的固有限制）；
 * 对应的耦合校验（assertOrgRealWiring）**不再于加载期抛错**，而是延迟到 DI
 * 装配入口求值（见 providers 首位的 ORG_WIRING_VALIDATION，评审⑤/info①）：
 * 静态 import 本模块不会因 shell 误导出而崩溃，误配在应用/测试编译装配时干净失败。
 */
const LOAD_TIME_ENV: NodeJS.ProcessEnv = { ...process.env };
const USE_PG = orgDbRealEnabled(LOAD_TIME_ENV);
const USE_HTTP_CASDOOR = orgCasdoorRealEnabled(LOAD_TIME_ENV);
const USE_PLATFORM_JOBS = orgJobsPlatformEnabled(LOAD_TIME_ENV);
const USE_NOTIFY_CHANNEL = orgNotifyChannelEnabled(LOAD_TIME_ENV);

/**
 * 加载期分支快照（评审 info③）：供测试/诊断断言"当前进程内缓存的模块实际走在
 * 哪个分支"——若 runner 共享模块缓存导致本模块以默认分支先行加载，真实分支
 * 套件可据此在 before() 阶段大声失败，避免静默"假绿"。
 */
export const ORG_WIRING_SNAPSHOT = {
  pg: USE_PG,
  httpCasdoor: USE_HTTP_CASDOOR,
  platformJobs: USE_PLATFORM_JOBS,
  notifyChannel: USE_NOTIFY_CHANNEL,
} as const;

/**
 * fail-fast 启动校验（评审 info 建议）：ORG_*_REAL 真实适配器分支依赖底层
 * adapters 模块 ADAPTERS_*_REAL 的对应真实实现。两者不同步会在首次 DB 访问
 * /通知投递时才暴露（延迟到运行期、且行为难定位）；此处启动期即抛错，把误配
 * 收敛在装配阶段。
 *
 * 依赖映射：
 * - ORG_DB_REAL=1 ⟹ ADAPTERS_DB_REAL=1（DB_ADAPTER 须为 PostgresDbAdapter，
 *   否则 OrgUnitOfWork/Postgres*Store 拿到 NotWired 桩）；
 * - ORG_NOTIFY_CHANNEL=1 ⟹ ADAPTERS_NOTIFY_REAL=1（ADAPTERS_NOTIFY 须为真实
 *   渠道，否则 NotifyChannelNotificationPort 拿到不可用桩，投递必然失败）。
 * - ORG_CASDOOR_REAL / ORG_JOBS_PLATFORM 不经 adapters 模块（前者走独立 HTTP
 *   适配器 + RANA_MINDER_CONFIG，后者走 platform/tasks TaskRepository），不设耦合。
 */
export function assertOrgRealWiring(env: NodeJS.ProcessEnv = process.env): void {
  if (orgDbRealEnabled(env) && env['ADAPTERS_DB_REAL'] !== '1') {
    throw new Error(
      'ORG_DB_REAL=1 但 ADAPTERS_DB_REAL 未开启：PostgreSQL 聚合仓储需要真实 ' +
        'DB_ADAPTER（PostgresDbAdapter），否则拿到 NotWired 桩。请同时设置 ' +
        'ADAPTERS_DB_REAL=1（或关闭 ORG_DB_REAL 保持 fail-closed 内存桩）。' +
        '（来源：当前进程环境变量；如为 shell 误导出请检查本进程 env）',
    );
  }
  if (orgNotifyChannelEnabled(env) && env['ADAPTERS_NOTIFY_REAL'] !== '1') {
    throw new Error(
      'ORG_NOTIFY_CHANNEL=1 但 ADAPTERS_NOTIFY_REAL 未开启：外部通知渠道需要真实 ' +
        'ADAPTERS_NOTIFY，否则 NotifyChannelNotificationPort 拿到不可用桩。请同时 ' +
        '设置 ADAPTERS_NOTIFY_REAL=1（或关闭 ORG_NOTIFY_CHANNEL）。' +
        '（来源：当前进程环境变量）',
    );
  }
}

/**
 * DI 装配期校验 provider（评审⑤/info①）：assertOrgRealWiring 不再于模块加载期
 * 作为顶层副作用执行——静态 import 本模块不会因 shell 误导出而崩溃；校验延迟到
 * Nest 容器编译/应用启动（DI 装配入口）时以加载期环境快照求值，误配仍 fail-fast，
 * 但表现为装配阶段干净失败而非 import 连锁崩溃。
 */
export const ORG_WIRING_VALIDATION = Symbol('ORG_WIRING_VALIDATION');
const OrgWiringValidationProvider = {
  provide: ORG_WIRING_VALIDATION,
  useFactory: () => {
    assertOrgRealWiring(LOAD_TIME_ENV);
    return true;
  },
};

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
    // ---- 装配校验（评审⑤/info①）：DI 编译/启动期执行，import 期不再抛错 ----
    OrgWiringValidationProvider,
    { provide: CLOCK, useFactory: () => new SystemClock() },
    // ---- CasdoorGroupPort ----
    ...(USE_HTTP_CASDOOR
      ? [
          {
            provide: CASDOOR_GROUP_PORT,
            useFactory: (config: RanaMinderConfig) => {
              const casdoor = config.casdoor;
              // 必填字段启动校验（评审 info②）：误配时拒绝以空 base 静默构造，
              // 与 DB/Notify 的 fail-fast 口径一致。
              const missing = (
                [
                  ['endpoint', casdoor.endpoint],
                  ['clientId', casdoor.clientId],
                  ['organization', casdoor.organization],
                ] as const
              )
                .filter(([, v]) => typeof v !== 'string' || v.trim() === '')
                .map(([k]) => k);
              if (missing.length > 0) {
                throw new Error(
                  `ORG_CASDOOR_REAL=1 但 config.casdoor 缺少必填字段：${missing.join('、')}。` +
                    'HttpCasdoorGroupAdapter 将以空 base 静默构造，故启动期即拒绝' +
                    '（与 DB/Notify fail-fast 同口径）。',
                );
              }
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
          {
            // ORG-M6 已知缺口（评审④）：RELATION_COMMAND_AUDIT_PORT 的 PG 审计仓储
            // 尚未实现。真实 DB 分支下：非生产以内存审计降级（重启即丢，仅开发联调）；
            // 生产 fail-fast 显式报错——禁止以进程内存审计对外服务（审计持久化要求）。
            provide: RELATION_COMMAND_AUDIT_PORT,
            useFactory: () => {
              if (process.env['NODE_ENV'] === 'production') {
                throw new Error(
                  '生产环境 ORG_DB_REAL=1 要求关系命令审计持久化（ORG-M6 已知缺口）：' +
                    'RELATION_COMMAND_AUDIT_PORT 的 PG 审计仓储尚未实现；' +
                    '落地前禁止启用真实 DB 分支（审计留痕不得仅存进程内存）。',
                );
              }
              return new InMemoryRelationCommandAuditStore();
            },
          },
        ]
      : [
          { provide: CLUB_STORE, useFactory: () => new InMemoryClubStore() },
          { provide: RELATION_COMMAND_STORE, useFactory: () => new InMemoryRelationCommandStore() },
          {
            // 非真实 DB 分支（纯内存桩模式）：audit 同为内存态；该分支本身仅限
            // 开发/测试（生产构造任一内存桩都会被 GOV-007 守卫拒绝）。
            provide: RELATION_COMMAND_AUDIT_PORT,
            useFactory: () => new InMemoryRelationCommandAuditStore(),
          },
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
