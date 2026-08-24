/**
 * AuditModule 删除/清理命令 DI 引导测试（防接口注入与可选依赖回归）。
 *
 * 背景：FormalDeleteCommand / ExecuteDeletionChecklistCommand / RetentionCleanupCommand
 * 目前尚未被任何 Controller/API 引用，仅经 AuditModule 导出，属后续接线分支的
 * 耦合面。为保证接线时 DI 可直接注入，本测试直接经 Nest 容器解析这三个命令，
 * 钉死其完整依赖链可解析：
 * - RetentionCleanupCommand / ExecuteDeletionChecklistCommand 注入 AuditWriter；
 * - AuditWriter 依赖 AUDIT_REPOSITORY / AuditSanitizer / AuditUnitOfWork，
 *   其中 AuditUnitOfWork 为可选依赖，必须标注 @Optional()（否则 Nest 仍按必填
 *   解析，耦合面接线时启动即失败——评审回归钉）。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Test } from '@nestjs/testing';

import { AuditModule } from './module';
import { ConfigurationModule, RANA_MINDER_CONFIG } from '../../config';
import type { RanaMinderConfig } from '../../config';
import { FormalDeleteCommand } from './application/commands/formal-delete.command';
import { ExecuteDeletionChecklistCommand } from './application/commands/execute-deletion-checklist.command';
import { RetentionCleanupCommand } from './application/commands/retention-cleanup.command';

/**
 * 完整 mock 配置：DI 引导阶段会把 @Global AdaptersModule 的 factory 全部实例化，
 * 其中 CASDOOR_AVAILABILITY factory 读取 config.casdoor.endpoint（无 fail-closed
 * 保护），故 mock 必须含 casdoor 字段，否则 Nest 启动失败。
 */
const mockRanaMinderConfig: RanaMinderConfig = {
  server: { port: 3000, host: '0.0.0.0', gracefulShutdownTimeoutMs: 10_000 },
  database: {
    host: 'localhost',
    port: 5432,
    name: 'test',
    user: 'test',
    schema: 'public',
    ssl: false,
    passwordRef: 'test',
  },
  casdoor: {
    endpoint: '',
    clientId: '',
    organization: '',
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
  mail: { host: '', port: 25, fromAddress: '' },
  fileCheck: { endpoint: '' },
  notify: { endpoint: '' },
  backup: { endpoint: '' },
  observability: { logLevel: 'info', traceSamplingRate: 1 },
  job: { schedulerIntervalMs: 1_000, defaultLeaseMs: 60_000, maxAttempts: 5 },
};

describe('AuditModule deletion commands DI bootstrap', () => {
  it('三个删除/清理命令可经 Nest DI 解析（含 AuditWriter 可选依赖链）', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [ConfigurationModule.forRoot(), AuditModule],
    })
      .overrideProvider(RANA_MINDER_CONFIG)
      .useValue(mockRanaMinderConfig)
      .compile();

    const commands = [
      moduleRef.get(FormalDeleteCommand),
      moduleRef.get(ExecuteDeletionChecklistCommand),
      moduleRef.get(RetentionCleanupCommand),
    ];
    for (const command of commands) {
      assert.ok(command, '删除/清理命令必须可经 DI 解析（后续接线分支依赖）');
    }
  });
});
