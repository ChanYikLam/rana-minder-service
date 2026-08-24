/**
 * 导出生成命令单测（5.4.4，EXP-001/EXP-002/EXP-003）。
 *
 * 覆盖验收点：
 * - 成功链路：领取租约 → 按冻结快照回源渲染 → 哈希/写对象存储 → 有效期回填 →
 *   审计 allowed → 站内信通知（顺序：先落库后副作用）；
 * - 幂等（EXP-003）：DOWNLOADABLE + 文件哈希重复投递 → 不重复写文件/通知/审计；
 * - 拒绝语义：任务不可见（IFC-ERR-015）、安全开关关闭（IFC-ERR-011，GOV-004）、
 *   状态冲突（IFC-ERR-007：FAILED 直接生成 / GENERATING 他者租约）、
 *   领取版本冲突（IFC-ERR-008 同持有者重入 / 异持有者拒绝）；
 * - 字段不越权（EXP-003）：回源查询字段 EXACTLY 冻结基线、纵深防御剥离越权键、
 *   未勾选联系方式时 phone/email 绝不出现在产物（闸门 + 端到端守卫）；
 * - 附件打包（EXP-002）：显式冻结才打包，ZIP 附 manifest.json 清单；
 * - 有效期（EXP-003）：默认 24h、超管配置可覆盖；
 * - 失败收敛（转换 4）：置 FAILED + 可披露原因 + 审计 denied，未知异常包装为
 *   ExportError；通知失败不影响业务结果。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { StatisticsSpecification } from '../../domain/models/statistics-specification';
import { ExportSnapshot } from '../../domain/models/export-snapshot';
import { ExportTaskAggregate, DEFAULT_EXPORT_VALIDITY_MS } from '../../domain/models/export-task';
import {
  ExportTaskStatus,
  ExportTaskStateMachine,
} from '../../domain/state-machines/export-task.state-machine';
import { ExportError } from '../errors';
import { InMemoryExportTaskRepository } from '../../infrastructure/in-memory-export-repository';
import { InMemoryExportFactSource } from '../../infrastructure/in-memory-export-fact-source';
import { InMemoryExportDatasetSource } from '../../infrastructure/in-memory-export-dataset-source';
import { InMemoryExportFileStore } from '../../infrastructure/in-memory-export-file-store';
import { InMemoryExportNotification } from '../../infrastructure/in-memory-export-notification';
import { MemoryExportRetentionConfig } from '../../infrastructure/memory-export-retention-config';
import {
  InMemoryExportAuditPort,
  MemoryExportSafetySwitchPort,
} from '../../infrastructure/memory-export-access';
import { XlsxExportFileRenderer } from '../../infrastructure/export-file/xlsx-export-file-renderer';
import { readZipArchive } from '../../infrastructure/export-file/zip-writer';
import type { ExportTaskRepository } from '../ports/export-repository.port';
import type { ExportRenderPlan } from '../ports/export-file-renderer.port';
import {
  ExportGenerationCommand,
  projectExportRows,
  assertContactOptInProjection,
  type ExportGenerationInput,
} from './export-generation.command';

const SPEC = new StatisticsSpecification();
const NOW = new Date('2026-03-09T08:05:06.789Z');
const WORKER = 'worker-1';

// ---------------------------------------------------------------------------
// 测试装置
// ---------------------------------------------------------------------------

interface Harness {
  repo: InMemoryExportTaskRepository;
  safety: MemoryExportSafetySwitchPort;
  datasetSource: InMemoryExportDatasetSource;
  renderer: XlsxExportFileRenderer;
  fileStore: InMemoryExportFileStore;
  retention: MemoryExportRetentionConfig;
  facts: InMemoryExportFactSource;
  audit: InMemoryExportAuditPort;
  notifications: InMemoryExportNotification;
  cmd: ExportGenerationCommand;
}

function makeHarness(overrides?: {
  repo?: ExportTaskRepository;
  renderer?: {
    render(plan: ExportRenderPlan): Promise<{ kind: 'xlsx' | 'zip'; bytes: Uint8Array }>;
  };
}): Harness {
  const repo = overrides?.repo ?? new InMemoryExportTaskRepository();
  const safety = new MemoryExportSafetySwitchPort();
  const datasetSource = new InMemoryExportDatasetSource();
  const renderer =
    overrides?.renderer ??
    ({
      render: async (plan: ExportRenderPlan) => new XlsxExportFileRenderer().render(plan),
    } as const);
  const fileStore = new InMemoryExportFileStore();
  const retention = new MemoryExportRetentionConfig();
  const facts = new InMemoryExportFactSource();
  const audit = new InMemoryExportAuditPort();
  const notifications = new InMemoryExportNotification();
  const cmd = new ExportGenerationCommand(
    repo,
    safety,
    datasetSource,
    renderer,
    fileStore,
    fileStore, // InMemoryExportFileStore 同时实现写入与处置端口（评审⑧）
    retention,
    facts,
    audit,
    notifications,
  );
  return {
    repo: repo as InMemoryExportTaskRepository,
    safety,
    datasetSource,
    renderer,
    fileStore,
    retention,
    facts,
    audit,
    notifications,
    cmd,
  };
}

/** 种子一个 PENDING_GENERATION 的社团导出任务 */
async function seedPendingTask(
  h: Harness,
  opts?: {
    exportId?: string;
    includeContact?: boolean;
    attachmentRefs?: readonly string[];
    academicYear?: string | null;
    timeRange?: { from: string; to: string } | null;
  },
): Promise<ExportTaskAggregate> {
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
    datasets: ['club_summary', 'current_members'],
    includeContact: opts?.includeContact ?? false,
    attachmentRefs: opts?.attachmentRefs ?? [],
    academicYear: opts?.academicYear ?? null,
    timeRange: opts?.timeRange ?? null,
    now: NOW,
  });
  const task = ExportTaskAggregate.create({
    machine: new ExportTaskStateMachine(),
    id: opts?.exportId ?? 'exp-1a2b3c4d',
    snapshot,
    ownerUserId: 'owner-1',
    authorizerUserId: null,
    requestedByUserId: 'hr-1',
    now: NOW,
  });
  task.markApplied(NOW);
  await h.repo.save(task);
  return task;
}

function baseInput(
  exportId: string,
  overrides?: Partial<ExportGenerationInput>,
): ExportGenerationInput {
  return { exportId, workerId: WORKER, now: NOW, ...overrides };
}

// ---------------------------------------------------------------------------
// 竞态仓储桩：模拟并发写者在命令乐观保存时抢先推进版本
// ---------------------------------------------------------------------------

/** 领取阶段竞争：首个 GENERATING 保存时以指定持有者抢先落库并抛版本冲突 */
class ClaimRacerRepo extends InMemoryExportTaskRepository {
  constructor(private readonly rivalHolder: string) {
    super();
  }
  private armed = true;
  async save(
    aggregate: Parameters<ExportTaskRepository['save']>[0],
    opts?: Parameters<ExportTaskRepository['save']>[1],
  ): Promise<void> {
    if (
      this.armed &&
      aggregate.status === ExportTaskStatus.GENERATING &&
      aggregate.fileHash === null &&
      opts?.expectedRevision !== undefined
    ) {
      this.armed = false;
      const data = {
        ...aggregate.toData(),
        revisionNumber: opts.expectedRevision,
        lease: {
          holderId: this.rivalHolder,
          until: new Date(NOW.getTime() + 60_000).toISOString(),
        },
      };
      await super.save(ExportTaskAggregate.fromSnapshot(new ExportTaskStateMachine(), data));
      throw new ExportError('IFC-ERR-008', `导出任务版本竞争（期望 ${opts.expectedRevision}）`);
    }
    return super.save(aggregate, opts);
  }
}

/** 成功落库阶段竞争：首个 DOWNLOADABLE 保存时并发写者抢先改写并抛版本冲突 */
class FinalSaveRacerRepo extends InMemoryExportTaskRepository {
  constructor(private readonly rivalPatch: 'terminal' | 'still_generating') {
    super();
  }
  private armed = true;
  async save(
    aggregate: Parameters<ExportTaskRepository['save']>[0],
    opts?: Parameters<ExportTaskRepository['save']>[1],
  ): Promise<void> {
    if (
      this.armed &&
      aggregate.status === ExportTaskStatus.DOWNLOADABLE &&
      opts?.expectedRevision !== undefined
    ) {
      this.armed = false;
      const base = aggregate.toData();
      const data =
        this.rivalPatch === 'terminal'
          ? {
              ...base,
              status: ExportTaskStatus.REVOKED,
              revokedReason: '参与社团 C1 紧急停用（JNT-023）',
              lease: null,
              fileRef: null,
              fileHash: null,
              fileSize: 0,
              expiresAt: null,
              revisionNumber: opts.expectedRevision,
            }
          : {
              ...base,
              status: ExportTaskStatus.GENERATING,
              // 竞争写者只触碰版本号：GENERATING 态必须保留本 worker 租约
              // （租约易主/丢失会被命令按"结果作废"分类处置，见命令冲突分支）
              lease: { holderId: WORKER, until: new Date(NOW.getTime() + 60_000).toISOString() },
              fileRef: null,
              fileHash: null,
              fileSize: 0,
              expiresAt: null,
              revisionNumber: opts.expectedRevision,
            };
      await super.save(ExportTaskAggregate.fromSnapshot(new ExportTaskStateMachine(), data));
      throw new ExportError('IFC-ERR-008', `导出任务版本竞争（期望 ${opts.expectedRevision}）`);
    }
    return super.save(aggregate, opts);
  }
}

// ---------------------------------------------------------------------------
// 成功链路
// ---------------------------------------------------------------------------

describe('ExportGenerationCommand — 成功链路（转换 2/3）', () => {
  it('PENDING → DOWNLOADABLE：文件/哈希/有效期/审计/通知全链路生效', async () => {
    const h = makeHarness();
    const task = await seedPendingTask(h);

    const res = await h.cmd.execute(baseInput(task.id));

    assert.equal(res.status, ExportTaskStatus.DOWNLOADABLE);
    assert.ok(res.fileHash);
    assert.equal(res.expiresAt, new Date(NOW.getTime() + DEFAULT_EXPORT_VALIDITY_MS).toISOString());

    const reloaded = await h.repo.load(task.id);
    assert.equal(reloaded?.status, ExportTaskStatus.DOWNLOADABLE);
    assert.equal(reloaded?.fileHash, res.fileHash);
    assert.ok(reloaded?.fileRef?.startsWith(`export-file://${task.id}/`));

    // 对象存储恰好一份产物（xlsx：无附件）
    assert.equal(h.fileStore.stored.length, 1);
    assert.equal(h.fileStore.stored[0].kind, 'xlsx');

    // 审计 allowed 一条，归属导出发起方
    const audits = h.audit.findBy('export_generate');
    assert.equal(audits.length, 1);
    assert.equal(audits[0].outcome, 'allowed');
    assert.equal(audits[0].principalId, 'hr-1');
    assert.equal(audits[0].privileged, false);

    // 站内信通知接收方为任务 owner（EXP-001），导出编号来自水印元数据
    assert.equal(h.notifications.events.length, 1);
    assert.equal(h.notifications.events[0].recipientUserId, 'owner-1');
    assert.equal(h.notifications.events[0].exportId, task.id);
    assert.match(h.notifications.events[0].exportNo, /^EXP-20260309-/);
  });

  it('工作表首行为字段表头，行值按列序投影', async () => {
    const h = makeHarness();
    const task = await seedPendingTask(h);
    await h.cmd.execute(baseInput(task.id));
    const bytes = h.fileStore.bytesOf((await h.repo.load(task.id))!.fileRef!);
    assert.ok(bytes);
    const archive = readZipArchive(bytes!);
    const worksheet = archive.text('xl/worksheets/sheet1.xml');
    // 表头：club_summary 冻结字段名逐个出现
    for (const field of ['metric', 'value', 'scope']) {
      assert.ok(worksheet.includes(`>${field}<`), `表头缺少字段 ${field}`);
    }
    // 数据行包含确定性种子的指标文案
    assert.ok(worksheet.includes('当前成员数'));
  });

  it('有效期可由配置端口覆盖（超管配置语义，EXP-003）', async () => {
    const h = makeHarness();
    h.retention.setValidityMs(60 * 60 * 1000);
    const task = await seedPendingTask(h);

    const res = await h.cmd.execute(baseInput(task.id));

    assert.equal(res.expiresAt, new Date(NOW.getTime() + 60 * 60 * 1000).toISOString());
  });

  it('academicYear/timeRange 从快照透传给回源端口（快照口径，EXP-003）', async () => {
    const h = makeHarness();
    const task = await seedPendingTask(h, {
      academicYear: '2025-2026',
      timeRange: { from: '2025-01-01T00:00:00.000Z', to: '2025-12-31T23:59:59.999Z' },
    });

    await h.cmd.execute(baseInput(task.id));

    const queries = h.datasetSource.queried;
    assert.ok(queries.length >= 2);
    for (const q of queries) {
      assert.equal(q.academicYear, '2025-2026');
      assert.deepEqual(q.timeRange, {
        from: '2025-01-01T00:00:00.000Z',
        to: '2025-12-31T23:59:59.999Z',
      });
      assert.equal(q.scope.kind, 'club');
      assert.equal(q.includeContact, false);
    }
  });
});

// ---------------------------------------------------------------------------
// 幂等（EXP-003）
// ---------------------------------------------------------------------------

describe('ExportGenerationCommand — 幂等回放（EXP-003）', () => {
  it('DOWNLOADABLE + 文件哈希重复投递 → 相同结果且零副作用', async () => {
    const h = makeHarness();
    const task = await seedPendingTask(h);
    const first = await h.cmd.execute(baseInput(task.id));

    const second = await h.cmd.execute(baseInput(task.id, { workerId: 'worker-2' }));

    assert.deepEqual(second, first);
    assert.equal(h.fileStore.stored.length, 1, '不得重复写对象存储');
    assert.equal(h.notifications.events.length, 1, '不得重复发站内信');
    assert.equal(h.audit.findBy('export_generate').length, 1, '不得重复审计');
  });
});

// ---------------------------------------------------------------------------
// 拒绝语义
// ---------------------------------------------------------------------------

describe('ExportGenerationCommand — 拒绝语义', () => {
  it('任务不存在 → IFC-ERR-015', async () => {
    const h = makeHarness();
    await assert.rejects(
      h.cmd.execute(baseInput('no-such-task')),
      (e: ExportError) => e.code === 'IFC-ERR-015',
    );
  });

  it('安全开关关闭 → IFC-ERR-011 且任务保持待生成、不留审计（GOV-004）', async () => {
    const h = makeHarness();
    const task = await seedPendingTask(h);
    h.safety.setAllowed(false, '演练封锁');

    await assert.rejects(
      h.cmd.execute(baseInput(task.id)),
      (e: ExportError) => e.code === 'IFC-ERR-011',
    );
    const reloaded = await h.repo.load(task.id);
    assert.equal(reloaded?.status, ExportTaskStatus.PENDING_GENERATION);
    assert.equal(h.audit.findBy('export_generate').length, 0);
  });

  it('FAILED 任务直接生成 → IFC-ERR-007（须经 retry 命令回队列）', async () => {
    const h = makeHarness();
    const task = await seedPendingTask(h);
    const claimed = await h.repo.load(task.id);
    claimed!.claimGeneration(WORKER, 60_000, NOW);
    claimed!.markGenerationFailed('渲染崩溃', NOW);
    await h.repo.save(claimed!);

    await assert.rejects(
      h.cmd.execute(baseInput(task.id)),
      (e: ExportError) => e.code === 'IFC-ERR-007',
    );
  });

  it('GENERATING 且租约属其他 worker → IFC-ERR-007，不改写任务', async () => {
    const h = makeHarness();
    const task = await seedPendingTask(h);
    const claimed = await h.repo.load(task.id);
    claimed!.claimGeneration('worker-other', 60_000, NOW);
    await h.repo.save(claimed!);

    await assert.rejects(
      h.cmd.execute(baseInput(task.id)),
      (e: ExportError) => e.code === 'IFC-ERR-007',
    );
    const reloaded = await h.repo.load(task.id);
    assert.equal(reloaded?.lease?.holderId, 'worker-other');
  });

  it('GENERATING 且租约为本 worker → 租约重入续跑成功', async () => {
    const h = makeHarness();
    const task = await seedPendingTask(h);
    const claimed = await h.repo.load(task.id);
    claimed!.claimGeneration(WORKER, 60_000, NOW);
    await h.repo.save(claimed!);

    const res = await h.cmd.execute(baseInput(task.id));
    assert.equal(res.status, ExportTaskStatus.DOWNLOADABLE);
  });
});

// ---------------------------------------------------------------------------
// 领取阶段版本冲突（IFC-ERR-008）
// ---------------------------------------------------------------------------

describe('ExportGenerationCommand — 领取版本冲突（IFC-ERR-008）', () => {
  it('冲突后重读为本 worker 名下 GENERATING → 租约重入继续生成', async () => {
    const h = makeHarness({ repo: new ClaimRacerRepo(WORKER) });
    const task = await seedPendingTask(h);

    const res = await h.cmd.execute(baseInput(task.id));

    assert.equal(res.status, ExportTaskStatus.DOWNLOADABLE);
    assert.ok(res.fileHash);
  });

  it('冲突后重读为其他 worker 名下 GENERATING → IFC-ERR-007', async () => {
    const h = makeHarness({ repo: new ClaimRacerRepo('worker-rival') });
    const task = await seedPendingTask(h);

    await assert.rejects(
      h.cmd.execute(baseInput(task.id)),
      (e: ExportError) => e.code === 'IFC-ERR-007',
    );
    // 任务保持对方持有的 GENERATING 态
    const reloaded = await h.repo.load(task.id);
    assert.equal(reloaded?.status, ExportTaskStatus.GENERATING);
    assert.equal(reloaded?.lease?.holderId, 'worker-rival');
  });
});

// ---------------------------------------------------------------------------
// 成功落库版本冲突（IFC-ERR-008 一次容忍）
// ---------------------------------------------------------------------------

describe('ExportGenerationCommand — 成功落库版本冲突', () => {
  it('期间已被推进至终态（失权）→ 静默作废本轮结果，不审计/不通知', async () => {
    const h = makeHarness({ repo: new FinalSaveRacerRepo('terminal') });
    const task = await seedPendingTask(h);

    const res = await h.cmd.execute(baseInput(task.id));

    // superseded：返回当前终态，不带成功产物字段
    assert.equal(res.status, ExportTaskStatus.REVOKED);
    assert.equal(res.fileHash, undefined);
    assert.equal(h.audit.findBy('export_generate').length, 0, 'superseded 不得记 allowed');
    assert.equal(h.notifications.events.length, 0, 'superseded 不得发通知');
    // 任务保持并发写者的失权态（不被覆盖）
    const reloaded = await h.repo.load(task.id);
    assert.equal(reloaded?.status, ExportTaskStatus.REVOKED);
  });

  it('期间仅版本被触碰（仍本 worker GENERATING）→ 以最新版本重存成功', async () => {
    const h = makeHarness({ repo: new FinalSaveRacerRepo('still_generating') });
    const task = await seedPendingTask(h);

    const res = await h.cmd.execute(baseInput(task.id));

    assert.equal(res.status, ExportTaskStatus.DOWNLOADABLE);
    assert.ok(res.fileHash);
    const reloaded = await h.repo.load(task.id);
    assert.equal(reloaded?.status, ExportTaskStatus.DOWNLOADABLE);
    assert.equal(reloaded?.fileHash, res.fileHash);
  });
});

// ---------------------------------------------------------------------------
// 字段不越权（EXP-003 快照口径 + 纵深防御）
// ---------------------------------------------------------------------------

describe('ExportGenerationCommand — 字段不越权（EXP-003）', () => {
  it('回源查询字段严格等于冻结基线（EXACTLY snapshot.fields）', async () => {
    const h = makeHarness();
    const task = await seedPendingTask(h);
    const frozen = await h.repo.load(task.id);

    await h.cmd.execute(baseInput(task.id));

    const queries = h.datasetSource.queried;
    assert.equal(queries.length, 2);
    for (const q of queries) {
      assert.deepEqual(q.fields, frozen!.snapshot.fields(q.dataset));
    }
  });

  it('数据源多返回的越权键被纵深防御剥离，绝不进入产物', async () => {
    const h = makeHarness();
    h.datasetSource.seed('current_members', [
      {
        userId: 'u-x',
        studentNo: 'S-001',
        departmentId: 'D1',
        departmentName: '技术部',
        positionId: null,
        academicYear: '2025-2026',
        // 越权/秘密列：不在任何冻结基线内
        idCard: 'SECRET-ID-CARD',
        internalNote: 'SECRET-NOTE',
        phone: '13800000001',
        email: 'x@example.edu',
      },
    ]);
    const task = await seedPendingTask(h);

    await h.cmd.execute(baseInput(task.id));

    const fileRef = (await h.repo.load(task.id))!.fileRef!;
    const archive = readZipArchive(h.fileStore.bytesOf(fileRef)!);
    const membersSheet = archive.text('xl/worksheets/sheet2.xml'); // 第二个数据集 current_members
    for (const forbidden of ['SECRET-ID-CARD', 'SECRET-NOTE', '13800000001', 'x@example.edu']) {
      assert.ok(!membersSheet.includes(forbidden), `产物泄露越权数据：${forbidden}`);
    }
    assert.ok(membersSheet.includes('u-x'), '白名单列正常导出');
  });

  it('未勾选联系方式时端到端守卫生效：phone 键即使混入也被剔除（EXP-002）', async () => {
    const h = makeHarness();
    // 种子行只有联系方式有差异：若投影被绕过，电话号码会出现在产物中
    h.datasetSource.seed('current_members', [
      {
        userId: 'u-y',
        studentNo: 'S-002',
        departmentId: null,
        departmentName: null,
        positionId: null,
        academicYear: '2025-2026',
        phone: '13911112222',
        email: 'leak@example.edu',
      },
    ]);
    const task = await seedPendingTask(h, { includeContact: false });

    await h.cmd.execute(baseInput(task.id));

    const fileRef = (await h.repo.load(task.id))!.fileRef!;
    const raw = Buffer.from(h.fileStore.bytesOf(fileRef)!).toString('latin1');
    assert.ok(!raw.includes('13911112222'), '电话号码必须被剥离');
    assert.ok(!raw.includes('leak@example.edu'), '邮箱必须被剥离');
  });

  it('勾选 includeContact=true 的快照允许联系方式列进入产物（EXP-002 显式勾选）', async () => {
    const h = makeHarness();
    const task = await seedPendingTask(h, { includeContact: true });
    // 冻结基线此时并入 phone/email（clamp 已放行）；种子行提供对应值
    h.datasetSource.seed('current_members', [
      {
        userId: 'u-z',
        studentNo: 'S-003',
        departmentId: 'D1',
        departmentName: '技术部',
        positionId: null,
        academicYear: '2025-2026',
        phone: '13733334444',
        email: 'z@example.edu',
      },
    ]);

    await h.cmd.execute(baseInput(task.id));

    const fileRef = (await h.repo.load(task.id))!.fileRef!;
    const archive = readZipArchive(h.fileStore.bytesOf(fileRef)!);
    const membersSheet = archive.text('xl/worksheets/sheet2.xml');
    assert.ok(membersSheet.includes('13733334444'));
    assert.ok(membersSheet.includes('z@example.edu'));
  });

  it('projectExportRows：以白名单重建行（列序跟随 fields，多余键剥离，缺省补 null）', () => {
    const rows = [{ b: 2, a: 1, extra: 'LEAK' }];
    const out = projectExportRows(rows, ['a', 'b', 'missing']);
    assert.deepEqual(out, [{ a: 1, b: 2, missing: null }]);
    assert.deepEqual(Object.keys(out[0]), ['a', 'b', 'missing']);
    assert.equal(JSON.stringify(out).includes('LEAK'), false);
  });

  it('assertContactOptInProjection：未勾选而 fields 含联系方式 → IFC-ERR-005 硬失败（快照口径破坏防御）', () => {
    assert.deepEqual(assertContactOptInProjection(['userId', 'studentNo'], false), [
      'userId',
      'studentNo',
    ]);
    assert.deepEqual(assertContactOptInProjection(['userId', 'phone', 'email'], true), [
      'userId',
      'phone',
      'email',
    ]);
    assert.throws(
      () => assertContactOptInProjection(['userId', 'phone'], false),
      (e: unknown) => e instanceof ExportError && e.code === 'IFC-ERR-005',
    );
  });
});

// ---------------------------------------------------------------------------
// 附件打包（EXP-002）
// ---------------------------------------------------------------------------

describe('ExportGenerationCommand — 附件打包（EXP-002）', () => {
  it('显式冻结的附件按 ref 回源打包，ZIP 附导出清单 manifest.json', async () => {
    const h = makeHarness();
    h.facts.seedAttachmentContent({
      ref: 'att-C1-001',
      filename: '报名表.pdf',
      contentType: 'application/pdf',
      bytes: new Uint8Array([1, 2, 3, 4]),
    });
    const task = await seedPendingTask(h, { attachmentRefs: ['att-C1-001'] });

    await h.cmd.execute(baseInput(task.id));

    const fileRef = (await h.repo.load(task.id))!.fileRef!;
    assert.ok(fileRef.endsWith('.zip'));
    assert.equal(h.fileStore.stored[0].kind, 'zip');

    const archive = readZipArchive(h.fileStore.bytesOf(fileRef)!);
    assert.deepEqual([...archive.read('attachments/报名表.pdf')], [1, 2, 3, 4]);
    assert.ok(archive.find('导出数据.xlsx') !== undefined);
    const manifest = JSON.parse(archive.text('manifest.json')) as Record<string, unknown>;
    assert.ok(typeof manifest['exportNo'] === 'string' && manifest['exportNo'].startsWith('EXP-'));
    assert.deepEqual(manifest['attachments'], [
      { filename: '报名表.pdf', ref: 'att-C1-001', byteLength: 4 },
    ]);
    assert.ok(Array.isArray(manifest['datasets']));
  });

  it('快照未冻结附件引用 → 不打包附件（单一 XLSX，默认关语义）', async () => {
    const h = makeHarness();
    // 事实源里有附件也不得打包：只有快照 refs 才驱动回源
    h.facts.seedAttachmentContent({
      ref: 'att-orphan',
      filename: 'orphan.pdf',
      contentType: null,
      bytes: new Uint8Array([9]),
    });
    const task = await seedPendingTask(h);

    await h.cmd.execute(baseInput(task.id));

    const fileRef = (await h.repo.load(task.id))!.fileRef!;
    assert.ok(fileRef.endsWith('.xlsx'));
    const archive = readZipArchive(h.fileStore.bytesOf(fileRef)!);
    assert.equal(archive.find('attachments/orphan.pdf'), undefined);
  });
});

// ---------------------------------------------------------------------------
// 失败收敛（转换 4）
// ---------------------------------------------------------------------------

describe('ExportGenerationCommand — 失败收敛（转换 4）', () => {
  it('渲染失败 → 任务置 FAILED + 可披露原因 + 审计 denied，不通知不写文件', async () => {
    const h = makeHarness({
      renderer: {
        render: async () => {
          throw new Error('internal zip layout boom');
        },
      },
    });
    const task = await seedPendingTask(h);

    await assert.rejects(
      h.cmd.execute(baseInput(task.id)),
      (e: ExportError) => e.code === 'IFC-ERR-006',
    );

    const reloaded = await h.repo.load(task.id);
    assert.equal(reloaded?.status, ExportTaskStatus.FAILED);
    assert.ok(reloaded?.failureReason?.includes('IFC-ERR'), '失败原因须带稳定错误码（可披露）');
    assert.ok(!reloaded?.failureReason?.includes('boom'), '内部细节不得进入可披露原因');

    const audits = h.audit.findBy('export_generate');
    assert.equal(audits.length, 1);
    assert.equal(audits[0].outcome, 'denied');
    assert.ok(audits[0].reason?.includes('IFC-ERR'));

    assert.equal(h.fileStore.stored.length, 0, '失败不得留下对象存储产物');
    assert.equal(h.notifications.events.length, 0, '失败不得发完成通知');
  });

  it('未知异常（非 ExportError）包装为 ExportError 后重抛', async () => {
    const h = makeHarness();
    // 回源端口在调用时抛出非 ExportError 异常
    const failingSource = {
      loadDatasetRows: async () => {
        throw new TypeError('dataset source exploded');
      },
    };
    const task = await seedPendingTask(h);
    h.cmd = new ExportGenerationCommand(
      h.repo,
      h.safety,
      failingSource as never,
      h.renderer,
      h.fileStore,
      h.fileStore,
      h.retention,
      h.facts,
      h.audit,
      h.notifications,
    );

    await assert.rejects(
      h.cmd.execute(baseInput(task.id)),
      (e: ExportError) => e.code === 'IFC-ERR-006',
    );
    const reloaded = await h.repo.load(task.id);
    assert.equal(reloaded?.status, ExportTaskStatus.FAILED);
  });

  it('失败收敛遇版本冲突但任务仍在名下 → 以最新版本完成 FAILED 标记', async () => {
    // 包装仓储：对 FAILED 保存注入一次版本冲突（并发写者仅触碰版本）
    class FailedSaveRacerRepo extends InMemoryExportTaskRepository {
      private armed = true;
      async save(
        aggregate: Parameters<ExportTaskRepository['save']>[0],
        opts?: Parameters<ExportTaskRepository['save']>[1],
      ): Promise<void> {
        if (
          this.armed &&
          aggregate.status === ExportTaskStatus.FAILED &&
          opts?.expectedRevision !== undefined
        ) {
          this.armed = false;
          const data = { ...aggregate.toData(), revisionNumber: opts.expectedRevision };
          delete (data as { fileRef?: string }).fileRef;
          const revived = {
            ...data,
            status: ExportTaskStatus.GENERATING,
            failureReason: null,
            failureReasons: [],
            attempts: Math.max(0, data.attempts - 1),
            lease: { holderId: WORKER, until: new Date(NOW.getTime() + 60_000).toISOString() },
          };
          await super.save(ExportTaskAggregate.fromSnapshot(new ExportTaskStateMachine(), revived));
          throw new ExportError('IFC-ERR-008', '竞争');
        }
        return super.save(aggregate, opts);
      }
    }
    const h = makeHarness({
      repo: new FailedSaveRacerRepo(),
      renderer: {
        render: async () => {
          throw new ExportError('IFC-ERR-006', '渲染失败');
        },
      },
    });
    const task = await seedPendingTask(h);

    await assert.rejects(
      h.cmd.execute(baseInput(task.id)),
      (e: ExportError) => e.code === 'IFC-ERR-006',
    );

    const reloaded = await h.repo.load(task.id);
    assert.equal(reloaded?.status, ExportTaskStatus.FAILED, '冲突重试后仍须收敛为 FAILED');
    assert.equal(h.audit.findBy('export_generate')[0]?.outcome, 'denied');
  });

  it('站内信通知失败不使命令失败（尽力而为副作用，业务结果已持久化）', async () => {
    const h = makeHarness();
    const failingNotifications = {
      notifyExportCompleted: async () => {
        throw new Error('inbox unavailable');
      },
    };
    h.cmd = new ExportGenerationCommand(
      h.repo,
      h.safety,
      h.datasetSource,
      h.renderer,
      h.fileStore,
      h.fileStore,
      h.retention,
      h.facts,
      h.audit,
      failingNotifications as never,
    );
    const task = await seedPendingTask(h);

    const res = await h.cmd.execute(baseInput(task.id));

    assert.equal(res.status, ExportTaskStatus.DOWNLOADABLE);
    const audits = h.audit.findBy('export_generate');
    assert.equal(audits.length, 1);
    assert.equal(audits[0].outcome, 'allowed', '通知失败不影响 allowed 审计');
  });
});

// ---------------------------------------------------------------------------
// 内存数据集源桩行为（过滤/投影收口）
// ---------------------------------------------------------------------------

describe('InMemoryExportDatasetSource — 过滤与投影（5.4.4）', () => {
  it('academicYear 仅作用于具备该属性的行', async () => {
    const source = new InMemoryExportDatasetSource();
    const rows = await source.loadDatasetRows({
      dataset: 'current_members',
      scope: {
        kind: 'club',
        clubId: 'C1',
        departmentId: null,
        departmentIds: [],
        jointActivityId: null,
        participantClubIds: [],
      },
      fields: ['userId', 'academicYear'],
      includeContact: false,
      academicYear: '2025-2026',
      timeRange: null,
    });
    assert.deepEqual(rows, [
      { userId: 'u-mbr-001', academicYear: '2025-2026' },
      { userId: 'u-mbr-002', academicYear: '2025-2026' },
    ]);
  });

  it('timeRange 按 acceptedAt 过滤录取历史；聚合类数据集不受影响', async () => {
    const source = new InMemoryExportDatasetSource();
    const scope = {
      kind: 'club' as const,
      clubId: 'C1',
      departmentId: null,
      departmentIds: [] as readonly string[],
      jointActivityId: null,
      participantClubIds: [] as readonly string[],
    };
    const history = await source.loadDatasetRows({
      dataset: 'admission_history',
      scope,
      fields: ['userId', 'acceptedAt'],
      includeContact: false,
      academicYear: null,
      timeRange: { from: '2025-01-01T00:00:00.000Z', to: '2025-12-31T23:59:59.999Z' },
    });
    assert.deepEqual(history, [{ userId: 'u-mbr-001', acceptedAt: '2025-09-10T10:00:00.000Z' }]);

    const funnel = await source.loadDatasetRows({
      dataset: 'recruitment_funnel',
      scope,
      fields: ['stage'],
      includeContact: false,
      academicYear: null,
      timeRange: { from: '2030-01-01T00:00:00.000Z', to: '2030-12-31T00:00:00.000Z' },
    });
    assert.equal(funnel.length, 4, '漏斗为聚合行，无时间戳属性则不过滤');
  });

  it('seed() 覆盖默认种子；includeContact=false 时联系方式列被桩侧剔除', async () => {
    const source = new InMemoryExportDatasetSource();
    source.seed('joint_conclusions', [
      {
        jointActivityId: 'J-9',
        clubId: 'C9',
        clubName: null,
        conclusion: 'pending',
        total: 1,
        accepted: 0,
        rejected: 0,
        pending: 1,
      },
    ]);
    const rows = await source.loadDatasetRows({
      dataset: 'joint_conclusions',
      scope: {
        kind: 'joint',
        clubId: null,
        departmentId: null,
        departmentIds: [],
        jointActivityId: 'J-9',
        participantClubIds: ['C9'],
      },
      fields: ['jointActivityId', 'total'],
      includeContact: false,
      academicYear: null,
      timeRange: null,
    });
    assert.deepEqual(rows, [{ jointActivityId: 'J-9', total: 1 }]);
  });
});
