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
  // 自包含兜底：不依赖外部 .env.test——通知模块密钥加密在非开发环境要求主密钥，
  // 缺失时 NotificationModule 装配即抛错；此处注入仅测试进程内有效的测试键。
  if (!process.env['EMAIL_SECRET_CIPHER_KEY']) {
    process.env['EMAIL_SECRET_CIPHER_KEY'] = 'test-only-cipher-key';
  }
  process.env = {
    ...process.env,
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

  // ---- 防御性断言（评审 info③）：模块缓存分支必须与开关一致，否则大声失败 ----
  // 若日后换用共享进程的 runner（vitest/ts-mocha），./module 可能已被其他 spec
  // 以默认分支先加载并缓存——此时快照为全 false，本套件的"真实分支"断言会静默
  // 假绿。此处显式拒绝该状态。
  const snapshot = mod.ORG_WIRING_SNAPSHOT;
  if (!snapshot?.pg || !snapshot.httpCasdoor || !snapshot.platformJobs || !snapshot.notifyChannel) {
    throw new Error(
      `module.real-wiring.spec 需要独立进程运行：当前进程内 './module' 缓存的装配分支为 ` +
        `${JSON.stringify(snapshot)}（期望全 true）。共享 runner 会命中默认分支缓存，` +
        '导致真实分支断言假绿——请在 node --test 独立进程下运行本文件。',
    );
  }

  // 注意：不在此处恢复 process.env——buildModuleRef 的 DI 编译发生在测试期，
  // 需要保持 NODE_ENV=test（通知模块密钥加密在非开发环境强制要求主密钥）与
  // 各开关；统一在 after() 中还原整个进程环境。
});

after(() => {
  // 统一还原进程环境（含 NODE_ENV 与注入的测试主密钥），避免影响同 runner 其它文件
  process.env = { ...savedEnv };
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
  org: { superAdminUserIds: [] },
  job: { defaultLeaseMs: 60_000, schedulerIntervalMs: 1_000, maxAttempts: 5 },
};

/** 复用统一的编译配置：org 真实分支 + mock 全部外部依赖（可注入劣化 config 验证 fail-fast） */
function buildModuleRef(configOverride?: import('../../config').RanaMinderConfig) {
  return Test.createTestingModule({
    imports: [ConfigurationModule.forRoot(), OrganizationModule],
  })
    .overrideProvider(RANA_MINDER_CONFIG)
    .useValue(configOverride ?? mockConfig)
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

  it('ORG_CASDOOR_REAL=1：casdoor 必填字段缺失 → 启动期 fail-fast（评审 info②）', async () => {
    const badConfig: import('../../config').RanaMinderConfig = {
      ...mockConfig,
      casdoor: { ...mockConfig.casdoor, endpoint: '' },
    };
    // 空 endpoint 不允许静默构造空 base 的 HttpCasdoorGroupAdapter（与 DB/Notify 同口径）
    await assert.rejects(
      async () => {
        const moduleRef = await buildModuleRef(badConfig);
        moduleRef.get(orgPorts.CASDOOR_GROUP_PORT);
        await moduleRef.close();
      },
      (err: unknown) => err instanceof Error && /缺少必填字段.*endpoint/.test(err.message),
    );
  });
});
