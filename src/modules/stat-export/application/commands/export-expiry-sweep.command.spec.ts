/**
 * 导出过期清理命令单测（5.4.4，转换 8，EXP-003 / AUD-009）。
 *
 * 覆盖验收点：
 * - 到期可下载任务 → EXPIRED + 文件删除 + 审计 export_expire；
 * - 未到期/非可下载任务不受影响（幂等：重复扫描无副作用）；
 * - dispose 失败不回滚过期状态、不计入 disposed（残留窗口兜底说明见命令 JSDoc）；
 * - 无文件引用的到期任务照常过期（disposed 不计）；
 * - 版本冲突一次容忍：重读后仍到期则完成收敛；终态 meanwhile 跳过且不中断整批。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { ExportSnapshot } from '../../domain/models/export-snapshot';
import { ExportTaskAggregate, DEFAULT_EXPORT_VALIDITY_MS } from '../../domain/models/export-task';
import {
  ExportTaskStatus,
  ExportTaskStateMachine,
} from '../../domain/state-machines/export-task.state-machine';
import type { ExportWatermarkMetadata } from '../../domain/services/export-watermark.policy';
import { StatisticsSpecification } from '../../domain/models/statistics-specification';
import { ExportError } from '../errors';
import { InMemoryExportAuditPort } from '../../infrastructure/memory-export-access';
import { InMemoryExportFileStore } from '../../infrastructure/in-memory-export-file-store';
import { InMemoryExportTaskRepository } from '../../infrastructure/in-memory-export-repository';
import type { ExportTaskRepository } from '../ports/export-repository.port';
import { ExportExpirySweepCommand } from './export-expiry-sweep.command';

const SPEC = new StatisticsSpecification();
const NOW = new Date('2026-03-09T08:05:06.789Z');
const LATER = new Date(NOW.getTime() + DEFAULT_EXPORT_VALIDITY_MS + 60_000); // 有效期后 1 分钟
const BEFORE = new Date(NOW.getTime() + 60_000); // 有效期内

// ---------------------------------------------------------------------------
// 测试装置
// ---------------------------------------------------------------------------

/** dispose 可配置失败的处置桩（包装内存文件存储） */
class ThrowingDisposal {
  private readonly failingRefs = new Set<string>();
  constructor(private readonly backing: InMemoryExportFileStore) {}
  failOn(fileRef: string): void {
    this.failingRefs.add(fileRef);
  }
  async dispose(fileRef: string): Promise<void> {
    if (this.failingRefs.has(fileRef)) {
      throw new Error('object storage unavailable');
    }
    await this.backing.dispose(fileRef);
  }
}

interface Harness {
  repo: InMemoryExportTaskRepository;
  store: InMemoryExportFileStore;
  audit: InMemoryExportAuditPort;
}

function makeHarness(repoOverride?: ExportTaskRepository): Harness {
  const repo = repoOverride ?? new InMemoryExportTaskRepository();
  return {
    repo: repo as InMemoryExportTaskRepository,
    store: new InMemoryExportFileStore(),
    audit: new InMemoryExportAuditPort(),
  };
}

function makeWatermark(generatedAt: Date): ExportWatermarkMetadata {
  return {
    exportNo: 'EXP-20260309-TEST',
    exporterUserId: 'hr-1',
    exporterName: null,
    clubId: 'C1',
    clubName: null,
    generatedAtIso: generatedAt.toISOString(),
    watermarkText: '导出人:hr-1｜所属社团:C1｜生成时间:x｜导出编号:EXP-20260309-TEST',
  };
}

/** 种子一个 DOWNLOADABLE 任务（已生成成功、带有效期与对象存储产物；fileRef 与存储一致） */
async function seedDownloadable(h: Harness, opts?: { id?: string }): Promise<ExportTaskAggregate> {
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
  const id = opts?.id ?? 'exp-due-1';
  const task = ExportTaskAggregate.create({
    machine: new ExportTaskStateMachine(),
    id,
    snapshot,
    ownerUserId: 'owner-1',
    authorizerUserId: null,
    requestedByUserId: 'hr-1',
    now: NOW,
  });
  task.markApplied(NOW);
  task.claimGeneration('worker-1', 60_000, NOW);
  // 先写对象存储取得一致 fileRef，再回填聚合（保证 dispose 目标真实存在）
  const written = await h.store.write({
    exportId: id,
    exportNo: 'EXP-20260309-TEST',
    kind: 'xlsx',
    bytes: new Uint8Array([1]),
    watermark: makeWatermark(NOW),
  });
  task.markGenerationSucceeded({
    fileRef: written.fileRef,
    fileHash: `hash-${id}`,
    fileSize: written.fileSize,
    now: NOW,
  });
  await h.repo.save(task);
  return (await h.repo.load(id))!;
}

// ---------------------------------------------------------------------------
// 用例
// ---------------------------------------------------------------------------

describe('ExportExpirySweepCommand — 过期收敛（转换 8）', () => {
  it('到期可下载任务 → EXPIRED + 文件删除 + 审计 export_expire', async () => {
    const h = makeHarness();
    const task = await seedDownloadable(h);
    const cmd = new ExportExpirySweepCommand(h.repo, h.store, h.audit);

    const res = await cmd.run(LATER);

    assert.deepEqual(res, { expired: 1, disposed: 1 });
    const reloaded = await h.repo.load(task.id);
    assert.equal(reloaded?.status, ExportTaskStatus.EXPIRED);

    const audits = h.audit.findBy('export_expire');
    assert.equal(audits.length, 1);
    assert.equal(audits[0].outcome, 'allowed');
    assert.equal(audits[0].principalId, 'system');
    assert.equal(audits[0].exportId, task.id);
  });

  it('未到期任务不受影响；到期后收敛一次、重复扫描幂等', async () => {
    const h = makeHarness();
    await seedDownloadable(h, { id: 'exp-fresh' });
    const cmd = new ExportExpirySweepCommand(h.repo, h.store, h.audit);

    const first = await cmd.run(BEFORE);
    assert.deepEqual(first, { expired: 0, disposed: 0 });
    assert.equal((await h.repo.load('exp-fresh'))?.status, ExportTaskStatus.DOWNLOADABLE);

    // 到期后再扫：恰好一次收敛
    const second = await cmd.run(LATER);
    assert.deepEqual(second, { expired: 1, disposed: 1 });
    // 重复扫描零副作用（命令幂等）
    const third = await cmd.run(new Date(LATER.getTime() + 86_400_000));
    assert.deepEqual(third, { expired: 0, disposed: 0 });
    assert.equal(h.audit.findBy('export_expire').length, 1);
  });

  it('dispose 失败不回滚过期状态、不计入 disposed（best-effort 清理）', async () => {
    const h = makeHarness();
    const task = await seedDownloadable(h);
    const throwing = new ThrowingDisposal(h.store);
    throwing.failOn(task.fileRef!);
    const cmd = new ExportExpirySweepCommand(h.repo, throwing as never, h.audit);

    const res = await cmd.run(LATER);

    assert.deepEqual(res, { expired: 1, disposed: 0 });
    const reloaded = await h.repo.load(task.id);
    assert.equal(reloaded?.status, ExportTaskStatus.EXPIRED, '存储故障不得回滚状态机收敛');
    assert.equal(h.audit.findBy('export_expire').length, 1, '过期审计不受清理失败影响');
  });

  it('无文件引用的到期任务照常过期（disposed 不计）', async () => {
    const h = makeHarness();
    // 直接构造 DOWNLOADABLE 但 fileRef 为空的异常存量数据（历史脏数据兜底）
    const seeded = await seedDownloadable(h, { id: 'exp-no-file' });
    const data = { ...seeded.toData(), fileRef: null };
    await h.repo.save(ExportTaskAggregate.fromSnapshot(new ExportTaskStateMachine(), data));
    const cmd = new ExportExpirySweepCommand(h.repo, h.store, h.audit);

    const res = await cmd.run(LATER);

    assert.deepEqual(res, { expired: 1, disposed: 0 });
    assert.equal((await h.repo.load('exp-no-file'))?.status, ExportTaskStatus.EXPIRED);
  });

  it('版本冲突一次容忍：重读后仍到期则收敛成功；终态 meanwhile 跳过不中断整批', async () => {
    /** 按任务 id 注入一次性版本冲突：exp-retry-ok 仅触碰版本、exp-raced-terminal 终态化 */
    class RacerRepo extends InMemoryExportTaskRepository {
      private readonly armed = new Set<string>();
      constructor(private readonly rivalPlan: Readonly<Record<string, 'touch' | 'terminal'>>) {
        super();
      }
      async save(
        aggregate: Parameters<ExportTaskRepository['save']>[0],
        opts?: Parameters<ExportTaskRepository['save']>[1],
      ): Promise<void> {
        const plan = this.rivalPlan[aggregate.id];
        if (
          plan !== undefined &&
          !this.armed.has(aggregate.id) &&
          aggregate.status === ExportTaskStatus.EXPIRED &&
          opts?.expectedRevision !== undefined
        ) {
          this.armed.add(aggregate.id);
          const base = aggregate.toData();
          const rival =
            plan === 'touch'
              ? // 仅触碰版本：竞争写者未改业务状态——须还原为命令变更前的
                // 可下载且已到期状态（aggregate 入参已被 expire() 原地推进，
                // 直接落库会伪装成"他人已完成收敛"，与测试意图不符）
                { ...base, status: ExportTaskStatus.DOWNLOADABLE }
              : // 并发失权：已推进至终态 → 命令应跳过该条
                {
                  ...base,
                  status: ExportTaskStatus.REVOKED,
                  revokedReason: '参与社团 C1 紧急停用（JNT-023）',
                  lease: null,
                };
          await super.save(
            ExportTaskAggregate.fromSnapshot(new ExportTaskStateMachine(), {
              ...rival,
              revisionNumber: opts.expectedRevision,
            }),
          );
          throw new ExportError('IFC-ERR-008', `导出任务版本竞争（期望 ${opts.expectedRevision}）`);
        }
        return super.save(aggregate, opts);
      }
    }
    const h = makeHarness(
      new RacerRepo({ 'exp-retry-ok': 'touch', 'exp-raced-terminal': 'terminal' }),
    );
    await seedDownloadable(h, { id: 'exp-retry-ok' });
    await seedDownloadable(h, { id: 'exp-raced-terminal' });
    const cmd = new ExportExpirySweepCommand(h.repo, h.store, h.audit);

    const res = await cmd.run(LATER);

    // 第一条经重读重试收敛成功；第二条被并发终态化后跳过
    assert.equal(res.expired, 1);
    assert.equal(res.disposed, 1);
    assert.equal((await h.repo.load('exp-retry-ok'))?.status, ExportTaskStatus.EXPIRED);
    assert.equal((await h.repo.load('exp-raced-terminal'))?.status, ExportTaskStatus.REVOKED);
    assert.equal(h.audit.findBy('export_expire').length, 1, '被跳过的候选不留过期审计');
  });
});

// ---------------------------------------------------------------------------
// listDueForExpiry 仓储扫描口径
// ---------------------------------------------------------------------------

describe('InMemoryExportTaskRepository.listDueForExpiry — 扫描口径', () => {
  it('仅返回 DOWNLOADABLE 且 expiresAt 已到期（<=）的任务', async () => {
    const h = makeHarness();
    await seedDownloadable(h, { id: 'due' }); // 有效期至 NOW+24h

    assert.deepEqual(
      (await h.repo.listDueForExpiry(BEFORE.toISOString())).map((t) => t.id),
      [],
    );
    assert.deepEqual(
      (await h.repo.listDueForExpiry(LATER.toISOString())).map((t) => t.id),
      ['due'],
    );
    // 恰好等于到期时刻也算到期（<=）
    assert.deepEqual(
      (
        await h.repo.listDueForExpiry(
          new Date(NOW.getTime() + DEFAULT_EXPORT_VALIDITY_MS).toISOString(),
        )
      ).map((t) => t.id),
      ['due'],
    );
  });
});
