/**
 * 导出删除路径的对象存储清理单测（5.4.4，AUD-009 并清理）。
 *
 * 覆盖验收点：
 * - byApplicant 提前删除可下载任务 → 失效成功后按 fileRef 清理；
 * - 清理失败（存储故障）不阻断失效、不留异常，但失效与审计照常生效；
 * - 无文件引用的任务（待生成/失败态）删除不触发清理；
 * - 正式删除清单联动命中（AUD-009）→ 每个被失效且持有文件的任务都被清理；
 * - 参与社团紧急停用失权（JNT-023）→ 可下载任务清理、待生成任务无文件不清理。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { ExportSnapshot } from '../../domain/models/export-snapshot';
import { ExportTaskAggregate } from '../../domain/models/export-task';
import {
  ExportTaskStatus,
  ExportTaskStateMachine,
} from '../../domain/state-machines/export-task.state-machine';
import { StatisticsSpecification } from '../../domain/models/statistics-specification';
import {
  InMemoryExportAuditPort,
  MemoryExportSafetySwitchPort,
} from '../../infrastructure/memory-export-access';
import { InMemoryExportTaskRepository } from '../../infrastructure/in-memory-export-repository';
import type { ExportDisposalPort } from '../ports/export-disposal.port';
import { platformSuperAdminPrincipal } from '../export-authorization.policy';
import { ExportDeleteCommand } from './export-delete.command';

const SPEC = new StatisticsSpecification();
const NOW = new Date('2026-03-09T08:05:06.789Z');

/** 记录型处置桩：记录 dispose 调用序；可配置对指定引用抛错 */
class RecordingDisposal implements ExportDisposalPort {
  readonly calls: string[] = [];
  private readonly failing = new Set<string>();
  failOn(fileRef: string): void {
    this.failing.add(fileRef);
  }
  async dispose(fileRef: string): Promise<void> {
    this.calls.push(fileRef);
    if (this.failing.has(fileRef)) {
      throw new Error('object storage unavailable');
    }
  }
}

interface Harness {
  repo: InMemoryExportTaskRepository;
  safety: MemoryExportSafetySwitchPort;
  audit: InMemoryExportAuditPort;
  disposal: RecordingDisposal;
  del: ExportDeleteCommand;
}

function makeHarness(): Harness {
  const repo = new InMemoryExportTaskRepository();
  const safety = new MemoryExportSafetySwitchPort();
  const audit = new InMemoryExportAuditPort();
  const disposal = new RecordingDisposal();
  return {
    repo,
    safety,
    audit,
    disposal,
    del: new ExportDeleteCommand(safety, audit, repo, disposal),
  };
}

async function seedTask(
  h: Harness,
  opts: { id: string; status: 'PENDING' | 'DOWNLOADABLE'; clubId?: string },
): Promise<ExportTaskAggregate> {
  const { snapshot } = ExportSnapshot.freeze({
    spec: SPEC,
    scope: {
      kind: 'club',
      clubId: opts.clubId ?? 'C1',
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
    id: opts.id,
    snapshot,
    ownerUserId: 'owner-1',
    authorizerUserId: null,
    requestedByUserId: 'hr-1',
    now: NOW,
  });
  task.markApplied(NOW);
  if (opts.status === 'DOWNLOADABLE') {
    task.claimGeneration('worker-1', 60_000, NOW);
    task.markGenerationSucceeded({
      fileRef: `export-file://${opts.id}/EXP-TEST.xlsx`,
      fileHash: `hash-${opts.id}`,
      fileSize: 64,
      now: NOW,
    });
  }
  await h.repo.save(task);
  return (await h.repo.load(opts.id))!;
}

describe('ExportDeleteCommand — 删除联动对象存储清理（5.4.4，AUD-009）', () => {
  it('byApplicant：提前删除可下载任务后按 fileRef 清理', async () => {
    const h = makeHarness();
    const task = await seedTask(h, { id: 'exp-del-1', status: 'DOWNLOADABLE' });

    await h.del.byApplicant({
      principal: platformSuperAdminPrincipal('super-1'),
      exportId: task.id,
      expectedRevision: task.revisionNumber,
      now: NOW,
    });

    assert.deepEqual(h.disposal.calls, [`export-file://exp-del-1/EXP-TEST.xlsx`]);
    assert.equal((await h.repo.load(task.id))?.status, ExportTaskStatus.PRE_DELETED);
    assert.equal(h.audit.findBy('export_delete')[0]?.outcome, 'allowed');
  });

  it('byApplicant：清理失败不阻断删除（失效已生效，留日志即可）', async () => {
    const h = makeHarness();
    const task = await seedTask(h, { id: 'exp-del-2', status: 'DOWNLOADABLE' });
    h.disposal.failOn(task.fileRef!);

    await h.del.byApplicant({
      principal: platformSuperAdminPrincipal('super-1'),
      exportId: task.id,
      expectedRevision: task.revisionNumber,
      now: NOW,
    });

    // 清理被尝试过且失败未抛出
    assert.deepEqual(h.disposal.calls, [task.fileRef]);
    assert.equal((await h.repo.load(task.id))?.status, ExportTaskStatus.PRE_DELETED);
    assert.equal(h.audit.findBy('export_delete').length, 1);
  });

  it('byApplicant：无文件引用的任务（待生成态）删除不触发清理', async () => {
    const h = makeHarness();
    const task = await seedTask(h, { id: 'exp-del-3', status: 'PENDING' });

    await h.del.byApplicant({
      principal: platformSuperAdminPrincipal('super-1'),
      exportId: task.id,
      expectedRevision: task.revisionNumber,
      now: NOW,
    });

    assert.deepEqual(h.disposal.calls, []);
    assert.equal((await h.repo.load(task.id))?.status, ExportTaskStatus.PRE_DELETED);
  });

  it('applyFormalDelete：命中的可下载任务（含已过期存量）逐条失效并清理', async () => {
    const h = makeHarness();
    const downloadable = await seedTask(h, { id: 'exp-fd-1', status: 'DOWNLOADABLE' });
    // 已过期但保留文件的存量：AUD-009 includeTerminal=true 纳入联动清理
    const expired = await seedTask(h, { id: 'exp-fd-2', status: 'DOWNLOADABLE' });
    expired.expire(NOW);
    await h.repo.save(expired);

    const count = await h.del.applyFormalDelete({ selection: { clubId: 'C1' }, now: NOW });

    assert.equal(count, 2);
    assert.deepEqual(
      [...h.disposal.calls].sort(),
      ['export-file://exp-fd-1/EXP-TEST.xlsx', 'export-file://exp-fd-2/EXP-TEST.xlsx'].sort(),
    );
    assert.equal((await h.repo.load(downloadable.id))?.status, ExportTaskStatus.PRE_DELETED);
    assert.equal((await h.repo.load(expired.id))?.status, ExportTaskStatus.PRE_DELETED);
  });

  it('invalidateUnexpiredBySuspension：可下载任务失权后清理；待生成任务无文件不清理', async () => {
    const h = makeHarness();
    await seedTask(h, { id: 'exp-sus-1', status: 'DOWNLOADABLE' });
    await seedTask(h, { id: 'exp-sus-2', status: 'PENDING' });

    const count = await h.del.invalidateUnexpiredBySuspension({ clubId: 'C1', now: NOW });

    assert.equal(count, 2);
    assert.deepEqual(h.disposal.calls, ['export-file://exp-sus-1/EXP-TEST.xlsx']);
    assert.equal((await h.repo.load('exp-sus-1'))?.status, ExportTaskStatus.REVOKED);
    assert.equal((await h.repo.load('exp-sus-2'))?.status, ExportTaskStatus.REVOKED);
  });
});
