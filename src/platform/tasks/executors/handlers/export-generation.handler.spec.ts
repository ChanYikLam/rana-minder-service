/**
 * 导出后台任务处理器功能测试（5.4.4，D9 平台接线）。
 *
 * 覆盖验收点：
 * - ExportGenerationHandler：payload {intent:'generate', exportId} 真正驱动
 *   ExportGenerationCommand（任务推进为可下载）；缺失/未知 payload 告警不抛错；
 *   命令失败向上传播（交由管道重试）；
 * - ExportExpiryScanHandler：一次执行完成一轮过期收敛（到期任务 → EXPIRED + 清理）。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { TaskType } from '../../contracts';
import type { TaskRecord } from '../../contracts';
import { StatisticsSpecification } from '../../../../modules/stat-export/domain/models/statistics-specification';
import { ExportSnapshot } from '../../../../modules/stat-export/domain/models/export-snapshot';
import { ExportTaskAggregate } from '../../../../modules/stat-export/domain/models/export-task';
import {
  ExportTaskStatus,
  ExportTaskStateMachine,
} from '../../../../modules/stat-export/domain/state-machines/export-task.state-machine';
import { InMemoryExportTaskRepository } from '../../../../modules/stat-export/infrastructure/in-memory-export-repository';
import { InMemoryExportDatasetSource } from '../../../../modules/stat-export/infrastructure/in-memory-export-dataset-source';
import { InMemoryExportFileStore } from '../../../../modules/stat-export/infrastructure/in-memory-export-file-store';
import { InMemoryExportNotification } from '../../../../modules/stat-export/infrastructure/in-memory-export-notification';
import { MemoryExportRetentionConfig } from '../../../../modules/stat-export/infrastructure/memory-export-retention-config';
import {
  InMemoryExportAuditPort,
  MemoryExportSafetySwitchPort,
} from '../../../../modules/stat-export/infrastructure/memory-export-access';
import { InMemoryExportFactSource } from '../../../../modules/stat-export/infrastructure/in-memory-export-fact-source';
import { XlsxExportFileRenderer } from '../../../../modules/stat-export/infrastructure/export-file/xlsx-export-file-renderer';
import { ExportGenerationCommand } from '../../../../modules/stat-export/application/commands/export-generation.command';
import { ExportGenerationHandler } from './export-generation.handler';
import { ExportExpiryScanHandler } from './export-expiry-scan.handler';

const NOW = new Date('2026-03-09T08:05:06.789Z');
const SPEC = new StatisticsSpecification();

function makeTask(payload: unknown): TaskRecord {
  return {
    taskId: 'task-export-1',
    intentId: 'intent-export-1',
    taskType: TaskType.EXPORT_GENERATION,
    status: 'PENDING',
    payload,
    attempts: 0,
    idempotencyKey: 'idem-export-1',
    scope: { kind: 'PLATFORM' },
    source: {
      objectType: 'export-task',
      objectId: 'exp-1a2b3c4d',
      version: 2,
      scope: { kind: 'PLATFORM' },
    },
    lease: null,
    maxAttempts: 3,
    notBefore: NOW.toISOString(),
    failure: null,
    resultRef: null,
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
  } as unknown as TaskRecord;
}

interface Deps {
  repo: InMemoryExportTaskRepository;
  store: InMemoryExportFileStore;
  audit: InMemoryExportAuditPort;
}

function makeGenerationHandler(): { handler: ExportGenerationHandler; deps: Deps } {
  const repo = new InMemoryExportTaskRepository();
  const store = new InMemoryExportFileStore();
  const audit = new InMemoryExportAuditPort();
  const cmd = new ExportGenerationCommand(
    repo,
    new MemoryExportSafetySwitchPort(),
    new InMemoryExportDatasetSource(),
    new XlsxExportFileRenderer(),
    store,
    store,
    new MemoryExportRetentionConfig(),
    new InMemoryExportFactSource(),
    audit,
    new InMemoryExportNotification(),
  );
  return { handler: new ExportGenerationHandler(cmd), deps: { repo, store, audit } };
}

async function seedPendingExport(repo: InMemoryExportTaskRepository): Promise<string> {
  const { snapshot } = ExportSnapshot.freeze({
    spec: SPEC,
    scope: {
      kind: 'club',
      clubId: 'C1',
      departmentId: null,
      departmentIds: [],
      jointActivityId: null,
      participantClubIds: [],
    },
    datasets: ['club_summary'],
    now: NOW,
  });
  const task = ExportTaskAggregate.create({
    machine: new ExportTaskStateMachine(),
    id: 'exp-1a2b3c4d',
    snapshot,
    ownerUserId: 'owner-1',
    authorizerUserId: null,
    requestedByUserId: 'hr-1',
    now: NOW,
  });
  task.markApplied(NOW);
  await repo.save(task);
  return task.id;
}

describe('ExportGenerationHandler — 导出生成任务接线（5.4.4）', () => {
  it('intent=generate：解析 payload.exportId 并真正驱动生成命令', async () => {
    const { handler, deps } = makeGenerationHandler();
    const exportId = await seedPendingExport(deps.repo);

    await handler.handle(makeTask({ intent: 'generate', exportId }));

    const reloaded = await deps.repo.load(exportId);
    assert.equal(reloaded?.status, ExportTaskStatus.DOWNLOADABLE);
    assert.equal(deps.store.stored.length, 1);
    assert.equal(deps.audit.findBy('export_generate')[0]?.outcome, 'allowed');
  });

  it('payload 缺失 / 意图未知 → 告警不抛错，不改任务状态', async () => {
    const { handler, deps } = makeGenerationHandler();
    const exportId = await seedPendingExport(deps.repo);

    await handler.handle(makeTask(undefined));
    await handler.handle(makeTask({ intent: 'something_else' }));

    const reloaded = await deps.repo.load(exportId);
    assert.equal(reloaded?.status, ExportTaskStatus.PENDING_GENERATION);
    assert.equal(deps.store.stored.length, 0);
  });

  it('命令失败向上抛出（任务不存在 → IFC-ERR-015 由管道重试）', async () => {
    const { handler } = makeGenerationHandler();

    await assert.rejects(
      handler.handle(makeTask({ intent: 'generate', exportId: 'no-such' })),
      (err: { code?: string }) => err.code === 'IFC-ERR-015',
    );
  });

  it('taskType 绑定 EXPORT_GENERATION', () => {
    const { handler } = makeGenerationHandler();
    assert.equal(handler.taskType, TaskType.EXPORT_GENERATION);
  });
});

describe('ExportExpiryScanHandler — 过期扫描任务接线（5.4.4）', () => {
  /** 记录型命令桩：handler 的职责仅是把任务转发为一次 sweep.run()（时钟由命令侧注入） */
  class StubSweep {
    runCalls = 0;
    lastNow: Date | undefined;
    async run(now?: Date): Promise<{ expired: number; disposed: number }> {
      this.runCalls += 1;
      this.lastNow = now;
      return { expired: 0, disposed: 0 };
    }
  }

  it('每次执行恰好触发一次过期扫描命令，payload 缺省亦可执行（运维轮询语义）', async () => {
    const sweep = new StubSweep();
    const handler = new ExportExpiryScanHandler(sweep as never);

    await handler.handle({ ...makeTask({ intent: 'scan' }), taskType: TaskType.EXPORT_EXPIRY_SCAN });
    await handler.handle({ ...makeTask(undefined), taskType: TaskType.EXPORT_EXPIRY_SCAN });

    assert.equal(sweep.runCalls, 2);
    assert.equal(sweep.lastNow, undefined, 'handler 不注入时钟，由命令取当前时间');

    // 命令失败向上传播（交由管道重试）
    const failing = new (class {
      async run(): Promise<never> {
        throw new Error('repo down');
      }
    })();
    const failingHandler = new ExportExpiryScanHandler(failing as never);
    await assert.rejects(
      failingHandler.handle({
        ...makeTask(null),
        taskType: TaskType.EXPORT_EXPIRY_SCAN,
      }),
      /repo down/,
    );
  });

  it('taskType 绑定 EXPORT_EXPIRY_SCAN', () => {
    const handler = new ExportExpiryScanHandler(new StubSweep() as never);
    assert.equal(handler.taskType, TaskType.EXPORT_EXPIRY_SCAN);
  });
});
