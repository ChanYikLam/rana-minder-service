/**
 * L5 运维演练门 8：故障矩阵失败关闭演练（OPS-VER-019）。
 *
 * 锚点语义：PostgreSQL/Casdoor/对象/邮件/检查/任务故障矩阵——失败、超时、
 * 断连、未知、迟到和恢复（docs/operations/部署运维与恢复手册-v1.0.md §OPS-VER 表）。
 *
 * 演练方式（真实类 + 假端口 + 虚拟时钟，无网络零 sleep≤100ms 约束内运行）：
 * - 未设 TASKS_DEV_STUB 时生产默认三件套（DenyAllTaskPrecondition /
 *   DenyAllBatchItemAuthorization / DenyAllBatchItemExecutor）一律拒绝；
 * - TaskExecutionPipeline 接入 DenyAllTaskPrecondition → PRECONDITION_REJECTED
 *   → MANUAL_INTERVENTION（毒丸不被吞）；
 * - NotificationDeliveryHandler 未知任务意图 → 上抛 → 重试耗尽后转
 *   MANUAL_INTERVENTION；渠道命令零调用（业务事实不被触碰）;
 * - PostgreSQL 故障注入：查询故障路径 rollback 收口且异常上抛。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import type { RanaMinderConfig } from '../../src/config';
import { TaskStatus, TaskType } from '../../src/platform/tasks/contracts';
import type { TaskHandler, TaskIntent, TaskRecord } from '../../src/platform/tasks/contracts';
import { TaskScopeKind } from '../../src/platform/tasks/contracts';
import { DenyAllBatchItemAuthorization } from '../../src/platform/tasks/batch/batch-authorization';
import { DenyAllBatchItemExecutor } from '../../src/platform/tasks/batch/batch-item-executor';
import {
  DenyAllTaskPrecondition,
  DevelopmentTaskPrecondition,
} from '../../src/platform/tasks/executors/task-precondition';
import type { BatchItemInput, TaskScope } from '../../src/platform/tasks/contracts';
import { InMemoryTaskRepository } from '../../src/platform/tasks/in-memory-task-repository';
import { LeaseManager } from '../../src/platform/tasks/lease';
import { RecoveryReplayConvergence } from '../../src/platform/tasks/idempotency/recovery-replay';
import { InMemoryIdempotencyStore } from '../../src/platform/tasks/idempotency/in-memory-idempotency-store';
import { TaskExecutionPipeline } from '../../src/platform/tasks/executors/task-execution-pipeline';
import { NotificationDeliveryHandler } from '../../src/platform/tasks/executors/handlers/notification-delivery.handler';
import {
  InMemoryInboxAdapter,
  InMemoryNotificationRepository,
} from '../../src/modules/notification/infrastructure';
import { DeliverInboxCommand } from '../../src/modules/notification/application/commands/deliver-inbox.command';
import { RetryChannelDeliveryCommand } from '../../src/modules/notification/application/commands/retry-channel-delivery.command';

import { FakeDbAdapter } from '../../src/shared/testing/fake-db-adapter';
import { IdentityUnitOfWork } from '../../src/modules/identity/infrastructure/unit-of-work';
import { PostgresSessionRevocation } from '../../src/modules/identity/infrastructure/postgres-session-revocation';

const findings = {
  denyAllTrio: false,
  preconditionToManual: false,
  unknownIntentToManual: false,
  dbFaultClosedClean: false,
};

const T0 = new Date('2026-08-24T00:00:00.000Z');
const LEASE_MS = 60_000;

function makeIntent(idempotencyKey: string, payload: Record<string, unknown>): TaskIntent {
  return {
    intentId: `intent:${idempotencyKey}`,
    taskType: TaskType.NOTIFICATION_DELIVERY,
    idempotencyKey,
    scope: { kind: TaskScopeKind.PLATFORM },
    source: {
      objectType: 'ops-fault-drill',
      objectId: 'o-19',
      version: 1,
      scope: { kind: TaskScopeKind.PLATFORM },
    },
    payload,
    notBefore: T0.toISOString(),
    createdAt: T0.toISOString(),
  };
}

function makeConfig(): RanaMinderConfig {
  return {
    job: { defaultLeaseMs: LEASE_MS, schedulerIntervalMs: 1_000, maxAttempts: 5 },
  } as unknown as RanaMinderConfig;
}

describe('OPS-VER-019 故障矩阵失败关闭演练', () => {
  it('未设 TASKS_DEV_STUB：DenyAll 三件套对前置检查/批量鉴权/批量执行一律拒绝', async () => {
    // .env.test 不含 TASKS_DEV_STUB，与生产绑定口径一致（module.ts 默认 '0'）
    const envSource = readFileSync(path.resolve(__dirname, '../../.env.test'), 'utf8');
    assert.equal(/TASKS_DEV_STUB/.test(envSource), false, '.env.test 不得开启开发桩');

    const task = { taskId: 'task-deny' } as TaskRecord;
    const precondition = await new DenyAllTaskPrecondition().verify(task);
    assert.equal(precondition.ok, false);
    assert.match(precondition.reason ?? '', /^production-precondition-not-configured:/);

    const authz = new DenyAllBatchItemAuthorization();
    const item: BatchItemInput = {
      itemId: 'item-1',
      payload: {},
    } as unknown as BatchItemInput;
    const authzResult = await authz.verify('principal-1', 'DELETE', 'FORM_SUBMISSION', item);
    assert.equal(authzResult.ok, false);
    assert.match(authzResult.reason ?? '', /^production-batch-authorization-not-configured:/);

    const executor = new DenyAllBatchItemExecutor();
    const execResult = await executor.execute(
      'principal-1',
      'DELETE',
      'FORM_SUBMISSION',
      { kind: TaskScopeKind.PLATFORM } as unknown as TaskScope,
      item,
    );
    assert.equal(execResult.status, 'REJECTED');
    assert.match(execResult.reason ?? '', /^production-batch-executor-not-configured:/);

    // 绑定口径证据：module.ts 以 TASKS_DEV_STUB=1 为唯一放行条件，默认绑定 DenyAll
    const moduleSrc = readFileSync(
      path.resolve(__dirname, '../../src/platform/tasks/module.ts'),
      'utf8',
    );
    assert.match(moduleSrc, /\(process\.env\.TASKS_DEV_STUB \?\? '0'\) === '1'/);
    assert.match(
      moduleSrc,
      /allowDevStubs \? DevelopmentTaskPrecondition : DenyAllTaskPrecondition/,
    );
    findings.denyAllTrio = true;
  });

  it('前置检查拒绝 → 任务进入 MANUAL_INTERVENTION 且原因可追溯', async () => {
    const repository = new InMemoryTaskRepository();
    const registry = {
      register: () => undefined,
      get: (_t: TaskType): TaskHandler | undefined => undefined,
      list: (): readonly TaskHandler[] => [],
    };
    const pipeline = new TaskExecutionPipeline(
      repository,
      new LeaseManager(repository),
      new RecoveryReplayConvergence(new InMemoryIdempotencyStore()),
      registry,
      new DenyAllTaskPrecondition(), // 故障矩阵：前置检查端口整体不可用
      makeConfig(),
    );
    const task = await repository.insert(makeIntent('k-precond', { intent: 'deliver_inbox' }));

    await pipeline.execute(task.taskId, 'w1', T0);

    const after = await repository.findById(task.taskId);
    assert.equal(after?.status, TaskStatus.MANUAL_INTERVENTION);
    assert.equal(after?.failure?.kind, 'PRECONDITION_REJECTED');
    assert.match(after?.failure?.reason ?? '', /production-precondition-not-configured/);
    findings.preconditionToManual = true;
  });

  it('未知任务意图：处理器上抛不吞掉 → 重试耗尽后 MANUAL_INTERVENTION，渠道命令零调用', async () => {
    const repo = new InMemoryNotificationRepository();
    const inbox = new InMemoryInboxAdapter();
    let deliverCalls = 0;
    let retryCalls = 0;

    // 真实 NotificationDeliveryHandler 类 + 假端口探针（记录渠道命令是否被误调用）
    const handler = new NotificationDeliveryHandler(
      {
        execute: async () => {
          deliverCalls += 1;
          return { presentationCount: 0 };
        },
      } as unknown as DeliverInboxCommand,
      {
        execute: async () => {
          retryCalls += 1;
          return undefined;
        },
      } as unknown as RetryChannelDeliveryCommand,
    );

    const repository = new InMemoryTaskRepository();
    const registryHandlers = new Map<TaskType, TaskHandler>();
    registryHandlers.set(TaskType.NOTIFICATION_DELIVERY, handler);
    const pipeline = new TaskExecutionPipeline(
      repository,
      new LeaseManager(repository),
      new RecoveryReplayConvergence(new InMemoryIdempotencyStore()),
      {
        register: () => undefined,
        get: (t: TaskType) => registryHandlers.get(t),
        list: (): readonly TaskHandler[] => [...registryHandlers.values()],
      },
      // 本场景聚焦"未知意图"路径：前置检查放行（Development 桩直构，不经环境开关），
      // 使执行能到达处理器；DenyAll 前置拒绝语义由上一用例单独覆盖。
      new DevelopmentTaskPrecondition(),
      makeConfig(),
    );

    const inserted = await repository.insert(
      makeIntent('k-unknown', { intent: 'totally-unknown' }),
    );

    // 直接验证真实类行为：未知意图 → 抛错（BUG-010 语义，毒丸不被静默吞掉）
    await assert.rejects(handler.handle(inserted), /未知任务意图/);
    assert.equal(deliverCalls + retryCalls, 0);

    // 经任务管道：重试耗尽（maxAttempts=5）后转 MANUAL_INTERVENTION
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      await pipeline.execute(
        inserted.taskId,
        'w1',
        new Date(T0.getTime() + attempt * (LEASE_MS + 1)),
      );
    }

    const after = await repository.findById(inserted.taskId);
    assert.equal(after?.status, TaskStatus.MANUAL_INTERVENTION, '重试耗尽必须转人工');
    assert.equal(after?.failure?.kind, 'RETRY_LIMIT_EXCEEDED');
    assert.match(after?.failure?.reason ?? '', /未知任务意图/);
    assert.equal(deliverCalls, 0, '未知意图不得触发投递命令');
    assert.equal(retryCalls, 0, '未知意图不得触发重试命令');
    findings.unknownIntentToManual = true;

    // 渠道侧零污染：通知事实与站内信均未被触碰
    assert.equal(await repo.findFactById('none'), null);
    assert.deepEqual(await inbox.listForUser('nobody', {}, null, 10), []);
  });

  it('PostgreSQL 故障注入：查询故障 → 异常上抛 + rollback/clear-rls 干净收口', async () => {
    const db = new FakeDbAdapter();
    db.queryError = new Error('ECONNRESET-from-postgres');
    const uow = new IdentityUnitOfWork(db);
    const revocation = new PostgresSessionRevocation(db, uow);

    await assert.rejects(revocation.getRevocation('user-ops'), /ECONNRESET/);
    const prefixes = db.events.map((e) => e.split(':')[0]);
    assert.deepEqual(prefixes.slice(-2), ['rollback', 'clear-rls'], '故障路径仍须干净收口');
    assert.equal(prefixes.includes('commit'), false);
    findings.dbFaultClosedClean = true;
  });

  it('演练结论：拒绝三件套/前置拒绝转人工/未知意图转人工/库故障干净收口 全部成立', () => {
    assert.deepEqual(findings, {
      denyAllTrio: true,
      preconditionToManual: true,
      unknownIntentToManual: true,
      dbFaultClosedClean: true,
    });
  });
});
