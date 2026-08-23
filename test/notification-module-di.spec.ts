/**
 * 通知模块 DI 引导测试（防止接口注入回归：接口在运行时被类型擦除，
 * 必须用字符串 Token/类 Token 注入，否则模块无法启动）。
 *
 * 覆盖：
 * - NotificationModule 全部命令/查询/控制器可被 Nest DI 解析；
 * - TasksModule 引入 NotificationModule 后，NotificationDeliveryHandler
 *   能注入 DeliverInboxCommand / RetryChannelDeliveryCommand（评审 #1）。
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
 */
const TEST_CONFIG: RanaMinderConfig = {
  server: { port: 3000, host: '0.0.0.0', gracefulShutdownTimeoutMs: 10_000 },
  database: {
    host: 'localhost',
    port: 5432,
    name: 'ranaminder_test',
    user: 'test',
    schema: 'app',
    ssl: false,
    passwordRef: 'test-password',
  },
  casdoor: {
    endpoint: '',
    clientId: 'test-client',
    organization: 'test-org',
    redirectUri: 'http://localhost:3000/api/auth/callback',
    clientSecretRef: 'test-secret',
  },
  storage: {
    endpoint: 'http://localhost:9000',
    region: 'us-east-1',
    accessKeyRef: 'test-access',
    secretKeyRef: 'test-secret-key',
    buckets: {
      quarantine: 'quarantine',
      primary: 'primary',
      derived: 'derived',
    },
  },
  mail: {
    host: 'localhost',
    port: 25,
    fromAddress: 'noreply@example.edu',
  },
  fileCheck: { endpoint: '' },
  notify: { endpoint: '' },
  backup: { endpoint: '' },
  observability: { logLevel: 'warn', traceSamplingRate: 1 },
  job: { defaultLeaseMs: 60_000, schedulerIntervalMs: 1_000, maxAttempts: 5 },
};

describe('NotificationModule DI bootstrap', () => {
  it('NotificationModule 全部提供者可被解析（无接口注入回归）', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [ConfigurationModule.forRoot(), NotificationModule],
    })
      .overrideProvider(RANA_MINDER_CONFIG)
      .useValue(TEST_CONFIG)
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
      .useValue(TEST_CONFIG)
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
