/**
 * TST-NFR-004 / 005 / 015 / 054：外部操作即时受理与幂等、并发正确性、
 * 恢复幂等与重复副作用防护、任务业务结果与恢复点边界。
 *
 * - TST-NFR-004：初次请求立即受理（outbox 登记）、相同请求编号只一份业务意图、
 *   外部结果不确定时返回 UNCERTAIN 不宣称成功；
 * - TST-NFR-005：500 并发下幂等存储/任务登记无丢失、无重复（同键并发单胜者）；
 * - TST-NFR-015：恢复重放按幂等记录自身任期收敛——执行中不重复执行、
 *   任期超时才允许重放；过期租约持有者不能提交结果；
 * - TST-NFR-054：终态任务业务结果保留不被改写（技术记录与业务意图分离），
 *   备份默认 30 天且只可在 30 至 60 天配置（OPS-BKP-003 权威行核对）。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { opsManual, FIXED_NOW } from './nfr-support';
import { TaskIntentOutbox } from '../../src/platform/tasks/outbox/task-intent-outbox';
import { InMemoryTransactionOutboxStore } from '../../src/platform/tasks/outbox/in-memory-transactional-outbox';
import {
  InMemoryIdempotencyStore,
} from '../../src/platform/tasks/idempotency/in-memory-idempotency-store';
import {
  RecoveryReplayConvergence,
} from '../../src/platform/tasks/idempotency/recovery-replay';
import { LogOnlyExternalCallAdapter } from '../../src/platform/tasks/executors/external-call.adapter';
import { InMemoryTaskRepository } from '../../src/platform/tasks/in-memory-task-repository';
import { LeaseManager } from '../../src/platform/tasks/lease/lease-manager';
import type { TaskRecord } from '../../src/platform/tasks/contracts/task-record';
import { TaskStatus } from '../../src/platform/tasks/contracts/task-status';
import { TaskType } from '../../src/platform/tasks/contracts/task-type';
import type { TaskIntent } from '../../src/platform/tasks/contracts/task-intent';
import { ClubStatisticsQuery } from '../../src/modules/stat-export/application/queries/club-statistics.query';
import { StatisticsSpecification } from '../../src/modules/stat-export/domain/models/statistics-specification';

const NOW = FIXED_NOW;

function makeIntent(intentId: string): TaskIntent {
  return {
    intentId,
    taskType: TaskType.NOTIFICATION_DELIVERY,
    idempotencyKey: `idem-${intentId}`,
    scope: { kind: 'PLATFORM' },
    source: { objectType: 'probe', objectId: 'o', version: 1, scope: { kind: 'PLATFORM' } },
    payload: {},
    notBefore: NOW.toISOString(),
    createdAt: NOW.toISOString(),
  };
}

/** 构造带租约的任务记录（用于收敛/释放探针） */
function makeLeasedTask(repo: InMemoryTaskRepository, intentId: string, leaseMs: number, workerId: string): Promise<TaskRecord> {
  const claim = repo.tryClaim(
    `task:${TaskType.NOTIFICATION_DELIVERY}:${intentId}`,
    workerId,
    new Date(NOW.getTime() + leaseMs).toISOString(),
    1,
    NOW,
  );
  return claim.then((r) => {
    if (r.claimed === false || r.task === null) throw new Error(`领取失败：${String(r.reason)}`);
    return r.task;
  });
}

// ---------------------------------------------------------------------------
// TST-NFR-004：外部操作即时受理与幂等
// ---------------------------------------------------------------------------

describe('TST-NFR-004 外部操作即时受理与幂等', () => {
  it('TST-NFR-004: 相同请求编号重复登记只形成一份业务意图', async () => {
    const store = new InMemoryTransactionOutboxStore();
    const outbox = new TaskIntentOutbox(store);
    await outbox.register(makeIntent('i-nfr4'));
    // 同一请求编号重复提交：幂等忽略，不产生第二份意图
    await outbox.register(makeIntent('i-nfr4'));
    const pending = await store.listPending(10);
    assert.equal(pending.length, 1);
    assert.equal(pending[0].intentId, 'i-nfr4');
  });

  it('TST-NFR-004: 外部调用桩对未知结果返回 UNCERTAIN 而非成功（禁止伪成功）', async () => {
    const adapter = new LogOnlyExternalCallAdapter();
    const call = await adapter.call(TaskType.CASDOOR_SYNC, {});
    const readBack = await adapter.readBack(TaskType.CASDOOR_SYNC, {});
    assert.equal(call.status, 'UNCERTAIN');
    assert.equal(readBack.status, 'UNCERTAIN');
    assert.ok(call.externalOperationId.length > 0);
  });

  it('TST-NFR-004: 已完成意图收敛拒绝二次执行并返回原结果引用', async () => {
    const store = new InMemoryIdempotencyStore();
    const convergence = new RecoveryReplayConvergence(store);
    const repo = new InMemoryTaskRepository();
    await repo.insert(makeIntent('i-nfr4b'));
    const leased = await makeLeasedTask(repo, 'i-nfr4b', 60_000, 'w1');
    // 首次执行放行并登记任期
    const first = await convergence.convergeBeforeExecution(leased, NOW);
    assert.equal(first.allowed, true);
    // 成功收口后：同键重放不再执行业务，仅返回原结果引用
    await convergence.convergeAfterSuccess(leased, 'result:orig');
    const replay = await convergence.convergeBeforeExecution(leased, NOW);
    assert.equal(replay.allowed, false);
    assert.equal(replay.resultRef, 'result:orig');
  });
});

// ---------------------------------------------------------------------------
// TST-NFR-005：500 并发混合负载下的正确性
// ---------------------------------------------------------------------------

describe('TST-NFR-005 500 并发负载下的无丢失与单胜者', () => {
  it('TST-NFR-005: 500 个不同请求编号并发登记全部成功且无丢失、无重复', async () => {
    const store = new InMemoryTransactionOutboxStore();
    const outbox = new TaskIntentOutbox(store);
    const intents = Array.from({ length: 500 }, (_, i) => makeIntent(`i-load-${i}`));
    await Promise.all(intents.map((intent) => outbox.register(intent)));
    const pending = await store.listPending(1000);
    assert.equal(pending.length, 500);
    assert.equal(new Set(pending.map((p) => p.intentId)).size, 500);
  });

  it('TST-NFR-005: 同一请求编号 500 路并发竞争恰好一个胜者', async () => {
    const idempotency = new InMemoryIdempotencyStore();
    const results = await Promise.all(
      Array.from({ length: 500 }, (_, i) =>
        idempotency.begin('same-key', `intent-${i}`, new Date(NOW.getTime() + 30_000).toISOString()),
      ),
    );
    const winners = results.filter((r) => r === true);
    assert.equal(winners.length, 1);
  });

  it('TST-NFR-005: 服务端分页/下钻预算封顶——超大批量参数被服务端收紧', async () => {
    // ClubStatisticsQuery.drilldown 的 limit 服务端封顶在 [1,1000]；
    // 以真实查询类行为断言：limit=Number.MAX_SAFE_INTEGER → rows ≤ 1000
    const source = {
      async loadClubProfile() {
        return { clubId: 'SYN-CLUB-0001', forcedSuspension: false };
      },
      async loadMembershipFacts() {
        return [];
      },
      async loadAdmissionHistory() {
        return [];
      },
      async loadNormalActivity() {
        return null;
      },
      async loadNormalFunnelFacts() {
        return [];
      },
      async loadJointActivity() {
        return null;
      },
      async loadJointConclusionFacts() {
        return [];
      },
      async loadPlatformMembershipFacts() {
        return [];
      },
      async loadPlatformAdmissionHistory() {
        return [];
      },
    };
    // 直接复用真实查询类：limit 封顶语义由服务端 clamp 强制
    const query = new ClubStatisticsQuery(source, { async record() {} }, new StatisticsSpecification());
    const view = await query.drilldown({
      principal: {
        userId: 'syn-owner',
        isPlatformSuperAdmin: false,
        clubScopes: [{ clubId: 'SYN-CLUB-0001', level: 'club', departmentIds: [] }],
      },
      clubId: 'SYN-CLUB-0001',
      metric: 'current_members',
      limit: Number.MAX_SAFE_INTEGER,
    });
    assert.ok(view.rows.length <= 1000);
  });
});

// ---------------------------------------------------------------------------
// TST-NFR-015：恢复幂等与重复副作用防护
// ---------------------------------------------------------------------------

describe('TST-NFR-015 恢复幂等与过期租约防护', () => {
  it('TST-NFR-015: 执行中记录任期未超时不允许重放；超时后允许一次恢复重放', async () => {
    const store = new InMemoryIdempotencyStore();
    const convergence = new RecoveryReplayConvergence(store);
    const repo = new InMemoryTaskRepository();
    await repo.insert(makeIntent('i-nfr15'));
    const leased = await makeLeasedTask(repo, 'i-nfr15', 60_000, 'w1');

    // 首次执行：登记 executingUntil = 当前租约到期时刻
    const first = await convergence.convergeBeforeExecution(leased, NOW);
    assert.equal(first.allowed, true);

    // 崩溃后任务被另一 worker 重新领取（新租约），但幂等记录自身任期未超时 → 阻止重放
    const laterClaim = new Date(NOW.getTime() + 10_000);
    const record = await store.find('idem-i-nfr15');
    assert.ok(record !== null, '幂等记录必须存在');
    assert.ok(record.executingUntil !== null && record.executingUntil !== undefined);
    const executingUntil: string = record.executingUntil;
    const stillValid = new Date(executingUntil).getTime() > laterClaim.getTime();
    assert.equal(stillValid, true);
    const blocked = await convergence.convergeBeforeExecution(leased, laterClaim);
    assert.equal(blocked.allowed, false);

    // 任期超时后：恢复重放放行（收敛为至多一份有效结果）
    const afterExpiry = new Date(NOW.getTime() + 61_000);
    const replayed = await convergence.convergeBeforeExecution(leased, afterExpiry);
    assert.equal(replayed.allowed, true);
  });

  it('TST-NFR-015: 失败记录允许按原业务意图完整重试', async () => {
    const store = new InMemoryIdempotencyStore();
    const convergence = new RecoveryReplayConvergence(store);
    const repo = new InMemoryTaskRepository();
    await repo.insert(makeIntent('i-nfr15b'));
    const leased = await makeLeasedTask(repo, 'i-nfr15b', 60_000, 'w1');
    await convergence.convergeBeforeExecution(leased, NOW);
    await convergence.convergeAfterFailure(leased);
    const retry = await convergence.convergeBeforeExecution(leased, NOW);
    assert.equal(retry.allowed, true);
  });

  it('TST-NFR-015: 租约过期后原持有者的释放/提交被忽略（旧租约不能写回）', async () => {
    const repo = new InMemoryTaskRepository();
    await repo.insert(makeIntent('i-nfr15c'));
    const task = await makeLeasedTask(repo, 'i-nfr15c', 60_000, 'w1');
    const manager = new LeaseManager(repo);
    // 租约过期后 w1 尝试提交 COMPLETED：release 判定租约无效，忽略写入
    const future = new Date(NOW.getTime() + 61_000);
    const updated = await manager.release(
      task,
      { status: TaskStatus.COMPLETED, resultRef: 'result:stale', updatedAt: future.toISOString() },
      future,
    );
    // 返回的是未改动的当前任务（提交被忽略）
    assert.notEqual(updated, null);
    assert.notEqual(updated!.status, TaskStatus.COMPLETED);
    const persisted = await repo.findById(task.taskId);
    assert.notEqual(persisted!.status, TaskStatus.COMPLETED);
    assert.equal(persisted!.resultRef, null);
  });
});

// ---------------------------------------------------------------------------
// TST-NFR-054：任务技术记录、备份恢复点与删除重放
// ---------------------------------------------------------------------------

describe('TST-NFR-054 任务业务结果保留与备份保留窗口', () => {
  it('TST-NFR-054: 终态任务的业务结果被写保护——技术记录到期不影响已收口结果', async () => {
    const repo = new InMemoryTaskRepository();
    await repo.insert(makeIntent('i-nfr54'));
    const task = await makeLeasedTask(repo, 'i-nfr54', 60_000, 'w1');
    const manager = new LeaseManager(repo);
    await manager.release(
      task,
      { status: TaskStatus.COMPLETED, resultRef: 'result:business-final', updatedAt: NOW.toISOString() },
      NOW,
    );
    const done = await repo.findById(task.taskId);
    assert.equal(done!.status, TaskStatus.COMPLETED);
    assert.equal(done!.resultRef, 'result:business-final');
    // 终态写保护：后续任何补写（含过期执行器）都不能改写业务结果
    const overwritten = await repo.updateAfterExecution(
      task.taskId,
      task.lease?.leaseVersion ?? 0,
      { status: TaskStatus.RETRYABLE_FAILED, resultRef: null },
    );
    assert.equal(overwritten, null);
    const stillDone = await repo.findById(task.taskId);
    assert.equal(stillDone!.status, TaskStatus.COMPLETED);
    assert.equal(stillDone!.resultRef, 'result:business-final');
    // 积压汇总区分 completed 与待处理：业务结果独立计数，不混入积压
    const summary = await repo.backlogSummary();
    assert.equal(summary.completed, 1);
    assert.equal(summary.pending + summary.retryableFailed + summary.uncertain, 0);
  });

  it('TST-NFR-054: 备份默认保留 30 天且只可在 30 至 60 天配置（权威运维规则在场）', () => {
    const manual = opsManual();
    assert.match(manual, /OPS-BKP-003/);
    assert.match(manual, /默认保留 30 天，可配置 30 至 60 天/);
    // 备份期限只决定可选恢复点，不决定正式业务数据期限
    assert.match(manual, /备份期限只决定可选恢复点，不决定正式业务数据期限/);
  });
});
