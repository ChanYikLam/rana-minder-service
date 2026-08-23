/**
 * 通知模块 DI 引导测试（防止接口注入回归：接口在运行时被类型擦除，
 * 必须用字符串 Token/类 Token 注入，否则模块无法启动）。
 *
 * 覆盖：
 * - NotificationModule 全部命令/查询/控制器可被 Nest DI 解析；
 * - TasksModule 引入 NotificationModule 后，NotificationDeliveryHandler
 *   能注入 DeliverInboxCommand / RetryChannelDeliveryCommand（评审 #1）。
 *
 * 注意：identity 模块（被 NotificationModule 引入）的 CASDOOR_AVAILABILITY /
 * AUTH_SESSION_PROVIDER 会读取 RANA_MINDER_CONFIG.casdoor，AdaptersModule 的
 * DB_ADAPTER 等需要 RANA_MINDER_CONFIG。故本测试对每个用例都 override 一份
 * 完整的最小配置（casdoor 缺省为空串 → fail-closed RejectAll 会话桩）。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Test } from '@nestjs/testing';

import { NotificationModule } from '../src/modules/notification/notification.module';
import { ConfigurationModule, RANA_MINDER_CONFIG } from '../src/config';
import type { RanaMinderConfig } from '../src/config';
import { TasksModule } from '../src/platform/tasks/module';
import {
  DeliverInboxCommand,
  RetryChannelDeliveryCommand,
  ApplyKillSwitchCommand,
  MarkAllReadCommand,
  MarkPresentationStatusCommand,
} from '../src/modules/notification/application/commands';
import { NotificationQueryService } from '../src/modules/notification/application/queries';
import { NotificationController } from '../src/modules/notification/interfaces';
import { NotificationDeliveryHandler } from '../src/platform/tasks/executors/handlers/notification-delivery.handler';

/**
 * 测试用完整配置。编译 NotificationModule/TasksModule 会经 @Global AdaptersModule
 * 触发 RANA_MINDER_CONFIG 注入，且 identity 模块的会话装配会读取 casdoor.endpoint，
 * 因此必须提供完整配置（不能只给 job 片段，否则 casdoor 为 undefined 会在工厂内抛错）。
 * 通过 overrides 可覆盖个别字段，casdoor 缺省为空串 → fail-closed RejectAll 会话桩。
 */
function mockConfig(overrides: Partial<RanaMinderConfig> = {}): RanaMinderConfig {
  return {
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
    casdoor: { endpoint: '', clientId: '', organization: '', redirectUri: '', clientSecretRef: '' },
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
    ...overrides,
  };
}

describe('NotificationModule DI bootstrap', () => {
  it('NotificationModule 全部提供者可被解析（无接口注入回归）', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [ConfigurationModule.forRoot(), NotificationModule],
    })
      .overrideProvider(RANA_MINDER_CONFIG)
      .useValue(mockConfig())
      .compile();

    const commands = [
      moduleRef.get(DeliverInboxCommand),
      moduleRef.get(RetryChannelDeliveryCommand),
      moduleRef.get(ApplyKillSwitchCommand),
      moduleRef.get(MarkAllReadCommand),
      moduleRef.get(MarkPresentationStatusCommand),
    ];
    for (const command of commands) {
      assert.ok(command, '命令必须可解析');
    }
    assert.ok(moduleRef.get(NotificationQueryService));
    assert.ok(moduleRef.get(NotificationController));
  });

  it('TasksModule 注入的 NotificationDeliveryHandler 持有真实投递/重试命令（评审 #1）', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [ConfigurationModule.forRoot(), TasksModule],
    })
      .overrideProvider(RANA_MINDER_CONFIG)
      .useValue(mockConfig())
      .compile();

    const handler = moduleRef.get(NotificationDeliveryHandler);
    const self = handler as unknown as {
      deliverInbox?: unknown;
      retryChannel?: unknown;
    };
    assert.ok(self.deliverInbox, 'handler.deliverInbox 必须已注入 DeliverInboxCommand');
    assert.ok(self.retryChannel, 'handler.retryChannel 必须已注入 RetryChannelDeliveryCommand');
  });
});
