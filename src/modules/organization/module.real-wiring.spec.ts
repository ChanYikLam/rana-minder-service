/**
 * 组织模块 · 真实适配器分支装配冒烟测试（#68 / 评审 warning 建议）。
 *
 * 背景：module.ts 顶层按 process.env 求值 USE_PG / USE_HTTP_CASDOOR /
 * USE_PLATFORM_JOBS / USE_NOTIFY_CHANNEL 并执行 assertOrgRealWiring()（模块
 * 加载期即固定分支）。因此本文件在动态 import('./module') **之前**设置开关，
 * 让 OrganizationModule 走真实适配器分支；并显式开启对应的 ADAPTERS_*_REAL
 * 以满足 fail-fast 校验（顺带验证该守卫）。
 *
 * 覆盖（补充 module.spec.ts 仅验证布尔开关的缺口）：
 * - ORG_DB_REAL=1：五个聚合仓储解析为 Postgres* 真实实现；
 * - ORG_CASDOOR_REAL=1：CASDOOR_GROUP_PORT 解析为 HttpCasdoorGroupAdapter；
 * - ORG_JOBS_PLATFORM=1：JOB_SCHEDULER 经 forwardRef 引入 TasksModule 后解析为
 *   TaskRepositoryJobScheduler（验证 TasksModule↔NotificationModule↔Organization
 *   Module 三角 forwardRef 装配环可被 Nest 消解）；
 * - ORG_NOTIFY_CHANNEL=1：NOTIFICATION_PORT 解析为 NotifyChannelNotificationPort；
 * - RECONCILE_PORT 一律为真实 GroupReconcileService。
 *
 * 注：本文件为独立进程（node --test 每个 spec 单独运行），因此模块缓存在这里
 * 是干净的，可安全地以全开分支装配。
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Test } from '@nestjs/testing';

// 模块级共享引用（在 before 中经动态 import 填充）
let OrganizationModule: typeof import('./module').OrganizationModule;
let assertOrgRealWiring: typeof import('./module').assertOrgRealWiring;
let orgDbRealEnabled: typeof import('./module').orgDbRealEnabled;
let ORG_UNIT_OF_WORK: typeof import('./module').ORG_UNIT_OF_WORK;
let orgPorts: typeof import('./application/ports');
let DB_ADAPTER: typeof import('../../adapters/tokens').DB_ADAPTER;
let ADAPTERS_NOTIFY: typeof import('../../adapters/tokens').ADAPTERS_NOTIFY;
let RANA_MINDER_CONFIG: typeof import('../../config').RANA_MINDER_CONFIG;
let ConfigurationModule: typeof import('../../config').ConfigurationModule;
let TASK_REPOSITORY: typeof import('../../platform/tasks/contracts').TASK_REPOSITORY;
let PostgresClubStore: typeof import('./infrastructure/postgres/postgres-club.store').PostgresClubStore;
let PostgresRelationCommandStore: typeof import('./infrastructure/postgres/postgres-command.stores').PostgresRelationCommandStore;
let PostgresAppointmentCommandStore: typeof import('./infrastructure/postgres/postgres-command.stores').PostgresAppointmentCommandStore;
let PostgresGroupMappingRegistry: typeof import('./infrastructure/postgres/postgres-config.stores').PostgresGroupMappingRegistry;
let PostgresPermissionTemplateStore: typeof import('./infrastructure/postgres/postgres-config.stores').PostgresPermissionTemplateStore;
let HttpCasdoorGroupAdapter: typeof import('./infrastructure/http/http-casdoor-group.adapter').HttpCasdoorGroupAdapter;
let TaskRepositoryJobScheduler: typeof import('./infrastructure/task-repository.scheduler').TaskRepositoryJobScheduler;
let NotifyChannelNotificationPort: typeof import('./infrastructure/notify-channel.notification-port').NotifyChannelNotificationPort;
let GroupReconcileService: typeof import('./application/group-reconcile.service').GroupReconcileService;

const savedEnv: NodeJS.ProcessEnv = { ...process.env };

before(async () => {
  // ---- 设置装配开关（必须在动态 import('./module') 之前，否则顶层常量已固定）----
  process.env = {
    ...savedEnv,
    NODE_ENV: 'test',
    ORG_DB_REAL: '1',
    ORG_CASDOOR_REAL: '1',
    ORG_JOBS_PLATFORM: '1',
    ORG_NOTIFY_CHANNEL: '1',
    // 满足 assertOrgRealWiring 的 fail-fast 耦合校验
    ADAPTERS_DB_REAL: '1',
    ADAPTERS_NOTIFY_REAL: '1',
  };

  // 动态 import：确保模块在开关就位后才加载求值
  const mod = await import('./module');
  OrganizationModule = mod.OrganizationModule;
  assertOrgRealWiring = mod.assertOrgRealWiring;
  orgDbRealEnabled = mod.orgDbRealEnabled;
  ORG_UNIT_OF_WORK = mod.ORG_UNIT_OF_WORK;
  orgPorts = await import('./application/ports');
  const adaptersTokens = await import('../../adapters/tokens');
  DB_ADAPTER = adaptersTokens.DB_ADAPTER;
  ADAPTERS_NOTIFY = adaptersTokens.ADAPTERS_NOTIFY;
  const config = await import('../../config');
  RANA_MINDER_CONFIG = config.RANA_MINDER_CONFIG;
  ConfigurationModule = config.ConfigurationModule;
  const tasksContracts = await import('../../platform/tasks/contracts');
  TASK_REPOSITORY = tasksContracts.TASK_REPOSITORY;
  PostgresClubStore = (await import('./infrastructure/postgres/postgres-club.store'))
    .PostgresClubStore;
  const cmdStores = await import('./infrastructure/postgres/postgres-command.stores');
  PostgresRelationCommandStore = cmdStores.PostgresRelationCommandStore;
  PostgresAppointmentCommandStore = cmdStores.PostgresAppointmentCommandStore;
  const cfgStores = await import('./infrastructure/postgres/postgres-config.stores');
  PostgresGroupMappingRegistry = cfgStores.PostgresGroupMappingRegistry;
  PostgresPermissionTemplateStore = cfgStores.PostgresPermissionTemplateStore;
  HttpCasdoorGroupAdapter = (await import('./infrastructure/http/http-casdoor-group.adapter'))
    .HttpCasdoorGroupAdapter;
  TaskRepositoryJobScheduler = (await import('./infrastructure/task-repository.scheduler'))
    .TaskRepositoryJobScheduler;
  NotifyChannelNotificationPort = (
    await import('./infrastructure/notify-channel.notification-port')
  ).NotifyChannelNotificationPort;
  GroupReconcileService = (await import('./application/group-reconcile.service'))
    .GroupReconcileService;

  // 恢复 shell 环境（避免影响后续逻辑对 process.env 的读取）
  process.env = savedEnv;
});

after(() => {
  // 恢复 NODE_ENV，避免影响其它测试文件在同一 runner 下的行为（防御性）
  process.env = { ...savedEnv, NODE_ENV: 'test' };
});

// ---- 测试用 mock 依赖 ----
const mockDb = {} as import('../../shared/db-adapter').DbAdapter;
const mockNotify = {
  send: async () => undefined,
} as unknown as import('../../adapters/notify/external-notify.adapter').NotifyAdapter;
const mockTasks = {} as import('../../platform/tasks/contracts').TaskRepository;
const mockConfig: import('../../config').RanaMinderConfig = {
  server: { host: '127.0.0.1', port: 3000, gracefulShutdownTimeoutMs: 30_000 },
  database: {
    host: '127.0.0.1',
    port: 5432,
    name: 'test',
    user: 'test',
    schema: 'public',
    passwordRef: '',
    ssl: false,
  },
  casdoor: {
    endpoint: 'https://casdoor.example.edu',
    clientId: 'c',
    organization: 'o',
    redirectUri: '',
    clientSecretRef: '',
  },
  storage: {
    endpoint: '',
    region: '',
    accessKeyRef: '',
    secretKeyRef: '',
    buckets: { quarantine: '', primary: '', derived: '' },
  },
  mail: { host: '', port: 25, fromAddress: '', userRef: '', passwordRef: '' },
  fileCheck: { endpoint: '', tokenRef: '' },
  notify: { endpoint: '', tokenRef: '' },
  backup: { endpoint: '', tokenRef: '' },
  observability: { logLevel: 'info', traceSamplingRate: 1 },
  job: { defaultLeaseMs: 60_000, schedulerIntervalMs: 1_000, maxAttempts: 5 },
};

/** 复用统一的编译配置：org 真实分支 + mock 全部外部依赖 */
function buildModuleRef() {
  return Test.createTestingModule({
    imports: [ConfigurationModule.forRoot(), OrganizationModule],
  })
    .overrideProvider(RANA_MINDER_CONFIG)
    .useValue(mockConfig)
    .overrideProvider(DB_ADAPTER)
    .useValue(mockDb)
    .overrideProvider(ADAPTERS_NOTIFY)
    .useValue(mockNotify)
    .overrideProvider(TASK_REPOSITORY)
    .useValue(mockTasks)
    .compile();
}

describe('#68 真实适配器分支装配冒烟（开关全开，forwardRef 循环）', () => {
  it('开关与 fail-fast 耦合校验：真实分支开关已按预期开启', () => {
    const full = {
      ORG_DB_REAL: '1',
      ORG_CASDOOR_REAL: '1',
      ORG_JOBS_PLATFORM: '1',
      ORG_NOTIFY_CHANNEL: '1',
      ADAPTERS_DB_REAL: '1',
      ADAPTERS_NOTIFY_REAL: '1',
    } as NodeJS.ProcessEnv;
    assert.equal(orgDbRealEnabled(full), true);
    assert.doesNotThrow(() => assertOrgRealWiring(full));
    // 误配守卫独立生效
    assert.throws(() => assertOrgRealWiring({ ORG_DB_REAL: '1' }), /ADAPTERS_DB_REAL/);
  });

  it('ORG_DB_REAL=1：聚合仓储解析为 Postgres 真实实现（DB_ADAPTER mock）', async () => {
    const moduleRef = await buildModuleRef();
    assert.ok(moduleRef.get(orgPorts.CLUB_STORE) instanceof PostgresClubStore);
    assert.ok(
      moduleRef.get(orgPorts.RELATION_COMMAND_STORE) instanceof PostgresRelationCommandStore,
    );
    assert.ok(
      moduleRef.get(orgPorts.APPOINTMENT_COMMAND_STORE) instanceof PostgresAppointmentCommandStore,
    );
    assert.ok(
      moduleRef.get(orgPorts.PERMISSION_TEMPLATE_STORE) instanceof PostgresPermissionTemplateStore,
    );
    assert.ok(
      moduleRef.get(orgPorts.GROUP_MAPPING_REGISTRY) instanceof PostgresGroupMappingRegistry,
    );
    assert.ok(moduleRef.get(ORG_UNIT_OF_WORK));
    await moduleRef.close();
  });

  it('ORG_CASDOOR_REAL=1：CASDOOR_GROUP_PORT 解析为 HttpCasdoorGroupAdapter', async () => {
    const moduleRef = await buildModuleRef();
    assert.ok(moduleRef.get(orgPorts.CASDOOR_GROUP_PORT) instanceof HttpCasdoorGroupAdapter);
    await moduleRef.close();
  });

  it('ORG_JOBS_PLATFORM=1：JOB_SCHEDULER 经 forwardRef 三角环解析为 TaskRepositoryJobScheduler', async () => {
    const moduleRef = await buildModuleRef();
    assert.ok(moduleRef.get(orgPorts.JOB_SCHEDULER) instanceof TaskRepositoryJobScheduler);
    await moduleRef.close();
  });

  it('ORG_NOTIFY_CHANNEL=1：NOTIFICATION_PORT 解析为 NotifyChannelNotificationPort', async () => {
    const moduleRef = await buildModuleRef();
    assert.ok(moduleRef.get(orgPorts.NOTIFICATION_PORT) instanceof NotifyChannelNotificationPort);
    await moduleRef.close();
  });

  it('RECONCILE_PORT 一律为真实 GroupReconcileService', async () => {
    const moduleRef = await buildModuleRef();
    assert.ok(moduleRef.get(orgPorts.RECONCILE_PORT) instanceof GroupReconcileService);
    await moduleRef.close();
  });
});
