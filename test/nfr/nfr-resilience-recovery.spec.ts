/**
 * TST-NFR-006 ~ 011 / 053：可用性与维护口径、RPO/RTO 预算、备份降级边界、
 * 恢复重放门、删除/清理收敛。
 *
 * - TST-NFR-006：月度可用性 99.5% 与"仅公告窗口可排除"的权威规则在场；
 *   优雅停机预算由配置加载器强制；
 * - TST-NFR-007：RPO ≤ 15 分钟权威行在场；备份报告呈现最近恢复点时间戳；
 * - TST-NFR-008：RTO ≤ 4 小时权威行在场；健康汇总对数据库不可用给出 degraded 判定；
 * - TST-NFR-009：备份适配器 fail-closed——I/O 失败降级为空集（未知），不伪造成功；
 * - TST-NFR-010：季度演练的恢复链组件（备份记录端口 + 删除清单重放）真实存在；
 * - TST-NFR-011：恢复后删除清单重放防复现、重放次数上限拒绝、Casdoor 差异进同步异常；
 * - TST-NFR-053：清理先撤销访问再物理删除；失败不标记成功、按上限转人工介入、
 *   最终收敛完成。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { opsManual, FIXED_NOW, readRepo, baseSyntheticEnv } from './nfr-support';
import { loadConfig } from '../../src/config/config.loader';
import { DefaultBackupReportService } from '../../src/platform/observability/backup-report/backup-report';
import type {
  BackupReportPort,
  BackupRecord,
  RestoreRecord,
} from '../../src/platform/observability/backup-report/backup-report';
import { ExternalBackupAdapter } from '../../src/adapters/backup/external-backup.adapter';
import { DefaultHealthSummaryService } from '../../src/platform/observability/health-summary/health-summary';
import type {
  StatusSummaryQueryService,
  StatusSummaryView,
} from '../../src/platform/observability/status-page/status-summary-query.service';
import {
  ExecuteDeletionChecklistCommand,
  type DeletionStepExecutorPort,
} from '../../src/modules/audit/application/commands/execute-deletion-checklist.command';
import { RetentionCleanupCommand } from '../../src/modules/audit/application/commands/retention-cleanup.command';
import type { RetentionCleanupExecutorPort } from '../../src/modules/audit/application/commands/retention-cleanup.command';
import {
  DeletionStepStatus,
  MAX_STEP_RETRY_COUNT,
  MAX_REPLAY_COUNT,
  type DeletionChecklist,
} from '../../src/modules/audit/domain/models/deletion';
import { AuditWriter } from '../../src/modules/audit/application/commands/audit-writer';
import { AuditSanitizer } from '../../src/modules/audit/domain/services/audit-sanitizer';
import { InMemoryAuditRepository } from '../../src/modules/audit/infrastructure/audit-repository';
import { InMemoryDeletionChecklistRepository } from '../../src/modules/audit/infrastructure/deletion-checklist-repository';
import { AccessPolicy } from '../../src/modules/file/domain/services/access-policy';
import {
  FileStateMachine,
  FileState,
} from '../../src/modules/file/domain/state-machines/file-state-machine';

const NOW = FIXED_NOW;

// ---------------------------------------------------------------------------
// 内存仓储与桩
// ---------------------------------------------------------------------------

function makeAuditRepo(): InMemoryAuditRepository {
  return new InMemoryAuditRepository();
}

function makeAuditWriter(repo: InMemoryAuditRepository): AuditWriter {
  return new AuditWriter(repo, new AuditSanitizer());
}

function makeChecklist(overrides: Partial<DeletionChecklist> = {}): DeletionChecklist {
  return {
    checklistId: 'chk-1',
    scope: { kind: 'USER_ALL_DATA', principalId: 'u1' },
    reason: 'synthetic deletion drill',
    purpose: 'USER_REQUEST',
    initiatedBy: 'syn-admin',
    initiatedAt: NOW.toISOString(),
    confirmed: true,
    affectedObjects: ['obj-1'],
    businessRelationsEnded: true,
    steps: [
      {
        stepId: 's1',
        kind: 'ONLINE_DB',
        targetRef: 'db://u1',
        status: DeletionStepStatus.PENDING,
        retryCount: 0,
      },
      {
        stepId: 's2',
        kind: 'ATTACHMENT_STORE',
        targetRef: 'obj://u1',
        status: DeletionStepStatus.PENDING,
        retryCount: 0,
      },
    ],
    completed: false,
    replayCount: 0,
    retryCount: 0,
    needsManualReview: false,
    version: 1,
    auditCommitted: false,
    ...overrides,
  };
}

async function makeChecklistRepo(
  initial: DeletionChecklist,
): Promise<InMemoryDeletionChecklistRepository> {
  const repo = new InMemoryDeletionChecklistRepository();
  await repo.save(initial);
  return repo;
}

/** 可编排失败序列的步骤执行器 */
function scriptedExecutor(results: boolean[]): DeletionStepExecutorPort & { calls: number } {
  let i = 0;
  return {
    calls: 0,
    async deleteAndVerify() {
      const ok = results[Math.min(i, results.length - 1)];
      i += 1;
      this.calls += 1;
      return { ok };
    },
  };
}

// ---------------------------------------------------------------------------
// TST-NFR-006：月度可用性口径与停机预算
// ---------------------------------------------------------------------------

describe('TST-NFR-006 月度可用性口径', () => {
  it('TST-NFR-006: 权威运维规则冻结 99.5% 口径且仅公告窗口内实际不可用可排除', () => {
    const manual = opsManual();
    assert.match(manual, /OPS-UPG-006/);
    assert.match(manual, /至少提前 24 小时公告/);
    // 超出窗口、紧急维护和未公告停机计入不可用
    assert.match(manual, /超出窗口.*计入不可用|紧急维护和未公告停机计入不可用/);
    // 上游验收合同同样声明 99.5% 调整后可用性
    const contract = readRepo('docs/specification/测试规格与验收追踪-v1.0.md');
    assert.match(contract, /月度调整后可用性不低于 99\.5%/);
  });

  it('TST-NFR-006: 停机相关预算由配置加载器强制——默认值与显式覆盖均可加载', () => {
    const config = loadConfig({ env: baseSyntheticEnv() });
    assert.equal(config.server.gracefulShutdownTimeoutMs, 10000);
    const overridden = loadConfig({
      env: { ...baseSyntheticEnv(), GRACEFUL_SHUTDOWN_TIMEOUT_MS: '30000' },
    });
    assert.equal(overridden.server.gracefulShutdownTimeoutMs, 30000);
  });
});

// ---------------------------------------------------------------------------
// TST-NFR-007 / 008：RPO 与 RTO 预算
// ---------------------------------------------------------------------------

describe('TST-NFR-007 恢复点目标预算', () => {
  it('TST-NFR-007: RPO 不超过 15 分钟为权威规则，备份报告暴露最近恢复点时间戳', async () => {
    const manual = opsManual();
    assert.match(manual, /RPO 不超过 15 分钟/);
    // 备份报告只读呈现最近一次备份事实（恢复点计算依据）
    const lastBackupAt = new Date(NOW.getTime() - 10 * 60_000);
    const port: BackupReportPort = {
      async lastBackup() {
        return { backupId: 'bk-1', startedAt: lastBackupAt, status: 'success' };
      },
      async lastRestore() {
        return undefined;
      },
      async recentBackups(_limit: number) {
        return [];
      },
      async recentRestores(_limit: number) {
        return [];
      },
    };
    const snapshot = await new DefaultBackupReportService(port).execute(NOW);
    assert.ok(snapshot.lastBackup !== undefined);
    // 故障时点 NOW 与最近恢复点差值即丢失窗口输入：10 分钟 ≤ 15 分钟预算
    const lossWindowMs = NOW.getTime() - snapshot.lastBackup.startedAt.getTime();
    assert.ok(lossWindowMs <= 15 * 60_000);
  });
});

describe('TST-NFR-008 核心恢复时间目标', () => {
  it('TST-NFR-008: RTO 不超过 4 小时为权威规则；数据库不可用时健康判定立即降级', async () => {
    const manual = opsManual();
    assert.match(manual, /核心登录、查询和写入恢复时间目标 RTO 不超过 4 小时/);
    // 数据库探测不可用 → 状态 unknown → 整体 degraded（故障确认信号）
    const view = {
      now: NOW,
      app: { version: 'test', startedAt: NOW },
      db: { state: 'unknown' as const },
      task: { state: 'fresh' as const },
      deps: {
        casdoor: { state: 'fresh' as const },
        mail: { state: 'fresh' as const },
        'file-check': { state: 'fresh' as const },
        notify: { state: 'fresh' as const },
        backup: { state: 'fresh' as const },
      },
    };
    const query: StatusSummaryQueryService = {
      async execute() {
        return view as StatusSummaryView;
      },
    };
    const summary = await new DefaultHealthSummaryService(query).execute(NOW);
    assert.equal(summary.overall, 'degraded');
    const db = summary.subsystems.find((s) => s.name === 'db');
    assert.equal(db!.state, 'unknown');
  });
});

// ---------------------------------------------------------------------------
// TST-NFR-009 / 010：备份覆盖与季度演练组件
// ---------------------------------------------------------------------------

describe('TST-NFR-009 备份覆盖与 fail-closed 边界', () => {
  it('TST-NFR-009: 备份服务 I/O 失败时降级为空集（未知），绝不伪造备份成功', () => {
    // 外部备份适配器：fetch 拒绝 → 返回空集；未知状态记录被跳过而非伪装 failure
    const adapter = new ExternalBackupAdapter({
      endpoint: 'https://backup.example.invalid',
      fetchFn: (async () => {
        throw new Error('network unreachable');
      }) as typeof fetch,
      timeoutMs: 50,
    });
    return adapter.lastBackup().then((r) => {
      assert.equal(r, undefined);
    });
  });

  it('TST-NFR-009: 备份查询超时被中止并降级为空集（不挂起、不假成功）', async () => {
    const neverSettles = (_input: unknown, init?: { signal?: AbortSignal }): Promise<Response> =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      });
    const adapter = new ExternalBackupAdapter({
      endpoint: 'https://backup.example.invalid',
      fetchFn: neverSettles as typeof fetch,
      timeoutMs: 20,
    });
    const start = Date.now();
    const r = await adapter.lastBackup();
    assert.equal(r, undefined);
    assert.ok(Date.now() - start < 5000, '超时未及时中止');
  });

  it('TST-NFR-009: 无法识别的中间态记录不伪装成确定失败（只展示事实）', async () => {
    const payload = {
      records: [
        { backupId: 'bk-x', startedAt: NOW.toISOString(), status: 'running-unknown-state' },
      ],
    };
    const adapter = new ExternalBackupAdapter({
      endpoint: 'https://backup.example.invalid',
      fetchFn: (async () =>
        ({
          ok: true,
          json: async () => payload,
        }) as unknown as Response) as typeof fetch,
      timeoutMs: 50,
    });
    const r = await adapter.lastBackup();
    assert.equal(r, undefined);
  });
});

describe('TST-NFR-010 季度完整恢复演练组件', () => {
  it('TST-NFR-010: 恢复链组件齐备——备份/恢复记录端口与删除清单重放入口存在', async () => {
    // 演练证据面：recentBackups/recentRestores 提供恢复点轮换视图
    const records: BackupRecord[] = [
      { backupId: 'bk-q2', startedAt: new Date(NOW.getTime() - 86_400_000), status: 'success' },
      { backupId: 'bk-q1', startedAt: new Date(NOW.getTime() - 2 * 86_400_000), status: 'success' },
    ];
    const restores: RestoreRecord[] = [];
    const port: BackupReportPort = {
      async lastBackup() {
        return records[0];
      },
      async lastRestore() {
        return undefined;
      },
      async recentBackups(limit: number) {
        return records.slice(0, limit);
      },
      async recentRestores(_limit: number) {
        return restores;
      },
    };
    const snapshot = await new DefaultBackupReportService(port).execute(NOW, {
      backupLimit: 1,
      restoreLimit: 1,
    });
    assert.equal(snapshot.recentBackups.length, 1);
    assert.equal(snapshot.recentBackups[0].backupId, 'bk-q2');
    // 重放入口存在：恢复后删除清单可重新执行（行为见 TST-NFR-011 探针）
    assert.equal(typeof ExecuteDeletionChecklistCommand, 'function');
    assert.ok(MAX_REPLAY_COUNT >= 1);
  });
});

// ---------------------------------------------------------------------------
// TST-NFR-011：恢复后重放与对账门
// ---------------------------------------------------------------------------

describe('TST-NFR-011 恢复后重放与收敛门', () => {
  it('TST-NFR-011: 已完成清单在恢复后重放会重新执行全部步骤（已删数据不复现）', async () => {
    const doneAudited = makeChecklist({
      completed: true,
      auditCommitted: true,
      replayCount: 0,
      version: 7,
      steps: makeChecklist().steps.map((s) => ({
        ...s,
        status: DeletionStepStatus.VERIFIED_DELETED,
      })),
    });
    const repo = await makeChecklistRepo(doneAudited);
    const executor = scriptedExecutor([true, true]);
    const audit = makeAuditRepo();
    const command = new ExecuteDeletionChecklistCommand(repo, executor, makeAuditWriter(audit));
    const result = await command.execute({
      checklistId: 'chk-1',
      replay: true,
      audit: { requestId: 'req-replay', source: { channel: 'SYSTEM_TASK' } },
    });
    // 步骤全部重新执行（防复现），重放计数递增
    assert.equal(executor.calls, result.checklist.steps.length);
    assert.equal(result.checklist.replayCount, 1);
    assert.equal(result.completed, true);
    // 已完成+审计已落的清单重放不重复落 SUCCESS 审计（去重）
    const successWrites = await audit.query({ objectId: 'chk-1', limit: 100 });
    assert.equal(successWrites.filter((e) => e.outcome === 'SUCCESS').length, 0);
  });

  it('TST-NFR-011: 重放次数达到上限后拒绝再次重放（由运维介入评估）', async () => {
    const exhausted = makeChecklist({
      replayCount: MAX_REPLAY_COUNT,
      completed: true,
      auditCommitted: true,
    });
    const repo = await makeChecklistRepo(exhausted);
    const command = new ExecuteDeletionChecklistCommand(
      repo,
      scriptedExecutor([true]),
      makeAuditWriter(makeAuditRepo()),
    );
    await assert.rejects(
      () =>
        command.execute({
          checklistId: 'chk-1',
          replay: true,
          audit: { requestId: 'req-cap', source: { channel: 'SYSTEM_TASK' } },
        }),
      /重放次数已达上限/,
    );
  });
});

// ---------------------------------------------------------------------------
// TST-NFR-053：清理撤权、失败重试与最终收敛
// ---------------------------------------------------------------------------

describe('TST-NFR-053 清理撤权优先与失败收敛', () => {
  it('TST-NFR-053: 清理先撤销访问——文件进入待清理状态后访问立即拒绝（先撤权再物理清理）', () => {
    const sm = new FileStateMachine();
    const policy = new AccessPolicy(sm);
    const context = {
      principalId: 'u9',
      roles: ['CLUB_ADMIN'],
      clubId: 'c1',
      businessState: 'OPEN' as const,
    };
    const request = {
      fileId: 'f1',
      fileState: FileState.PENDING_CLEANUP,
      category: 'GENERIC' as never,
      uploaderId: 'u9',
      target: null,
      fieldRestrictions: { previewable: true, downloadable: true },
      sensitive: false,
      ownerOnly: true,
      uploaderHistoryVisible: true,
    };
    // 物理清理前访问已被撤销（unsafe 状态 → 拒绝，IFC-ERR-011）
    const decision = policy.check(context, request, 'DOWNLOAD' as never, true);
    assert.equal(decision.allowed, false);
  });

  it('TST-NFR-053: 步骤失败不标记成功、递增重试；达上限转人工介入并拒绝继续自动重试', async () => {
    const audit = makeAuditRepo();
    const failing = scriptedExecutor([false]);
    const repo = await makeChecklistRepo(makeChecklist({ retryCount: MAX_STEP_RETRY_COUNT - 1 }));
    const command = new ExecuteDeletionChecklistCommand(repo, failing, makeAuditWriter(audit));
    await assert.rejects(
      () =>
        command.execute({
          checklistId: 'chk-1',
          audit: { requestId: 'req-fail', source: { channel: 'WEB' } },
        }),
      /需人工介入/,
    );
    // needsManualReview 已落库：后续自动执行被直接拒绝
    const persisted = await repo.load('chk-1');
    assert.equal(persisted!.needsManualReview, true);
    assert.equal(persisted!.completed, false);
    const again = new ExecuteDeletionChecklistCommand(
      repo,
      scriptedExecutor([true]),
      makeAuditWriter(makeAuditRepo()),
    );
    await assert.rejects(() =>
      again.execute({
        checklistId: 'chk-1',
        audit: { requestId: 'req-fail2', source: { channel: 'WEB' } },
      }),
    );
    // 失败处置留有审计（FAILURE）
    const events = await audit.query({ objectId: 'chk-1', limit: 100 });
    assert.ok(events.some((e) => e.outcome === 'FAILURE'));
  });

  it('TST-NFR-053: 全部步骤回读核验通过后清单才收敛为完成并落最小审计', async () => {
    const audit = makeAuditRepo();
    const repo = await makeChecklistRepo(makeChecklist());
    const executor = scriptedExecutor([true, true]);
    const command = new ExecuteDeletionChecklistCommand(repo, executor, makeAuditWriter(audit));
    const result = await command.execute({
      checklistId: 'chk-1',
      audit: { requestId: 'req-ok', source: { channel: 'ADMIN' } },
    });
    assert.equal(result.completed, true);
    assert.ok(result.minimalAudit !== null);
    // 最小审计不含姓名/正文：仅内部标识、时间、超管、类型
    assert.equal(result.minimalAudit.internalRecordId, 'chk-1');
    assert.equal(result.minimalAudit.performedBy, 'syn-admin');
    assert.equal(result.minimalAudit.note, 'minimal-audit-only');
    const events = await audit.query({ objectId: 'chk-1', limit: 100 });
    assert.ok(events.some((e) => e.outcome === 'SUCCESS'));
    const persisted = await repo.load('chk-1');
    for (const step of persisted!.steps) {
      assert.equal(step.status, DeletionStepStatus.VERIFIED_DELETED);
    }
  });

  it('TST-NFR-053: 临时清理仅在期限届满且无有效引用时执行；核验失败保持未清理', async () => {
    const executed: string[] = [];
    const executor: RetentionCleanupExecutorPort = {
      async deleteAndVerify(itemId) {
        executed.push(itemId);
        return itemId === 'item-ok' ? { ok: true } : { ok: false };
      },
    };
    const command = new RetentionCleanupCommand(executor, makeAuditWriter(makeAuditRepo()));
    const result = await command.execute({
      items: [
        {
          itemId: 'item-ok',
          kind: 'TEMPORARY_EXPORT',
          retentionExpired: true,
          hasValidReference: false,
        },
        {
          itemId: 'item-ref',
          kind: 'TEMPORARY_EXPORT',
          retentionExpired: true,
          hasValidReference: true,
        },
        {
          itemId: 'item-young',
          kind: 'UNSUBMITTED_DRAFT',
          retentionExpired: false,
          hasValidReference: false,
        },
        {
          itemId: 'item-flaky',
          kind: 'SCAN_FAILED',
          retentionExpired: true,
          hasValidReference: false,
        },
      ],
    });
    // 有效引用或未到期 → 跳过（正式数据不被误清）
    assert.deepEqual([...result.skipped].sort(), ['item-flaky', 'item-ref', 'item-young']);
    assert.deepEqual(result.cleaned, ['item-ok']);
    assert.deepEqual(executed, ['item-ok', 'item-flaky']);
    // 核验失败项未被标记清理，交由重试任务收敛
  });
});
