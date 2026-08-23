import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryDeletionChecklistRepository } from '../../infrastructure/deletion-checklist-repository';
import { FormalDeleteCommand } from './formal-delete.command';
import {
  ExecuteDeletionChecklistCommand,
  DefaultDeletionStepExecutor,
} from './execute-deletion-checklist.command';
import {
  RetentionCleanupCommand,
  DefaultRetentionCleanupExecutor,
} from './retention-cleanup.command';
import { DeletionChecklistQuery } from '../queries/deletion-checklist.query';
import { DeletionPolicy } from '../../domain/services/deletion-policy';
import {
  DeletionScopeKind,
  DeletionStepKind,
  DeletionStepStatus,
  TemporaryItemKind,
} from '../../domain/models/deletion';
import type { DeletionChecklist } from '../../domain/models/deletion';

const makeAuditWriterStub = () => {
  const writes: unknown[] = [];
  const writer = { write: async (e: unknown) => void writes.push(e) };
  return { writes, writer: writer as never };
};

const makeRig = (executor: { ok: boolean } = { ok: true }) => {
  const repo = new InMemoryDeletionChecklistRepository();
  const policy = new DeletionPolicy();
  // 发起删除的审计留痕独立 stub（与执行清单审计分开计数，互不干扰）
  const initiateAudit = makeAuditWriterStub();
  const formalDelete = new FormalDeleteCommand(repo, policy, initiateAudit.writer);
  const audit = makeAuditWriterStub();
  const execute = new ExecuteDeletionChecklistCommand(
    repo,
    { deleteAndVerify: async () => executor } as never,
    audit.writer,
  );
  const cleanupAudit = makeAuditWriterStub();
  const cleanup = new RetentionCleanupCommand(
    {
      deleteAndVerify: async () => ({ ok: true }),
    } as never,
    cleanupAudit.writer,
  );
  const query = new DeletionChecklistQuery(repo, policy);
  return {
    repo,
    formalDelete,
    execute,
    cleanup,
    query,
    writes: audit.writes,
    cleanupWrites: cleanupAudit.writes,
    initiateWrites: initiateAudit.writes,
  };
};

const execInput = (checklistId: string, extra: Record<string, unknown> = {}) => ({
  checklistId,
  audit: { requestId: 'req-del', source: { channel: 'SYSTEM_TASK' as const } },
  ...extra,
});

const deleteInput = {
  initiator: { principalId: 'sa1', roles: ['SUPER_ADMIN'] },
  scope: { kind: DeletionScopeKind.USER_ALL_DATA, principalId: 'u1' },
  reason: '用户申请彻底删除本地数据',
  purpose: 'LEGAL_REQUIREMENT',
  confirmed: true,
  affectedObjects: ['报名:r1', '评价:e1'],
  activeRelations: [],
  audit: { requestId: 'req-del', source: { channel: 'ADMIN' as const } },
};

describe('5.3.4 正式删除与临时清理（AUD-005~010）', () => {
  it('前置校验：非超管/缺原因/未二次确认/变相匿名化/业务关系未结束 → 拒绝', async () => {
    const rig = makeRig();
    // 非超管
    await assert.rejects(
      rig.formalDelete.execute({
        ...deleteInput,
        initiator: { principalId: 'hr1', roles: ['HR_ADMIN'] },
      }),
      /仅超级管理员/,
    );
    // 缺原因
    await assert.rejects(
      rig.formalDelete.execute({ ...deleteInput, reason: '  ' }),
      /必须填写原因/,
    );
    // 未二次确认
    await assert.rejects(
      rig.formalDelete.execute({ ...deleteInput, confirmed: false }),
      /二次确认/,
    );
    // 白名单外用途（含匿名化措辞）→ 拒绝（I1 结构化白名单，防措辞绕过；AUD-010 不建设匿名化）
    await assert.rejects(
      rig.formalDelete.execute({ ...deleteInput, purpose: '匿名化保留统计' }),
      /不支持的删除用途/,
    );
    await assert.rejects(
      rig.formalDelete.execute({ ...deleteInput, purpose: 'LEGAL_REQUIREMENT2' }),
      /不支持的删除用途/,
    );
    // 业务关系未结束（有效邀请未结束 → 拒绝，AUD-008）
    await assert.rejects(
      rig.formalDelete.execute({
        ...deleteInput,
        activeRelations: [{ kind: 'INVITATION', ref: 'inv-1' }],
      }),
      /须先结束业务关系/,
    );
  });

  it('评审修复：scope 完整性校验——缺定位字段/空影响清单拒绝（IFC-ERR-005）', async () => {
    const rig = makeRig();
    // 单条记录缺 objectType/objectId
    await assert.rejects(
      rig.formalDelete.execute({
        ...deleteInput,
        scope: { kind: DeletionScopeKind.SINGLE_RECORD, objectType: 'RECORD' },
      }),
      /需提供 objectType 与 objectId/,
    );
    // 活动范围缺 activityId
    await assert.rejects(
      rig.formalDelete.execute({
        ...deleteInput,
        scope: { kind: DeletionScopeKind.ACTIVITY },
      }),
      /需提供 activityId/,
    );
    // 用户全部数据缺 principalId
    await assert.rejects(
      rig.formalDelete.execute({
        ...deleteInput,
        scope: { kind: DeletionScopeKind.USER_ALL_DATA },
      }),
      /需提供 principalId/,
    );
    // 空影响清单
    await assert.rejects(
      rig.formalDelete.execute({ ...deleteInput, affectedObjects: [] }),
      /受影响对象清单不能为空/,
    );
  });

  it('正式删除排队：生成 5 类步骤清单 + 受影响对象预览', async () => {
    const rig = makeRig();
    const checklist = await rig.formalDelete.execute(deleteInput);
    assert.equal(checklist.purpose, 'LEGAL_REQUIREMENT'); // 结构化用途随清单落库（合规追溯）
    assert.equal(checklist.completed, false);
    assert.equal(checklist.businessRelationsEnded, true);
    assert.equal(checklist.steps.length, 5);
    assert.deepEqual(
      checklist.steps.map((s) => s.kind),
      [
        DeletionStepKind.ONLINE_DB,
        DeletionStepKind.ATTACHMENT_STORE,
        DeletionStepKind.CACHE,
        DeletionStepKind.SEARCH_INDEX,
        DeletionStepKind.UNEXPIRED_EXPORT,
      ],
    );
    assert.ok(checklist.steps.every((s) => s.status === DeletionStepStatus.PENDING));
    // 受影响对象预览（二次确认展示；仅超管）
    const preview = await rig.query.previewAffected(checklist.checklistId, ['SUPER_ADMIN']);
    assert.deepEqual(preview, ['报名:r1', '评价:e1']);
    // 非超管查清单 → 拒绝（安全缺口修复）
    await assert.rejects(
      rig.query.previewAffected(checklist.checklistId, ['HR_ADMIN']),
      /仅超级管理员/,
    );
    // 发起正式删除（超管敏感操作）本身落审计留痕（AUD-006/008；评审 warning 修复）
    assert.equal(rig.initiateWrites.length, 1);
    const initWrite = rig.initiateWrites[0] as {
      eventType: string;
      actorId: string;
      target: { objectId: string };
    };
    assert.equal(initWrite.eventType, 'SUPER_ADMIN_OP');
    assert.equal(initWrite.actorId, 'sa1');
    assert.equal(initWrite.target.objectId, checklist.checklistId);
  });

  it('评审修复：占位删除/清理执行器 fail-closed（未接线即抛错，绝不静默假删除）', async () => {
    // 默认占位删除执行器：调用删除并回读核验即抛错（不再恒返回 {ok:true}）
    const stepExecutor = new DefaultDeletionStepExecutor();
    await assert.rejects(
      stepExecutor.deleteAndVerify('ONLINE_DB', 'db:u1'),
      /删除步骤执行器未接线/,
    );
    // 默认占位清理执行器：调用清理即抛错（不再恒返回 {ok:true}）
    const cleanupExecutor = new DefaultRetentionCleanupExecutor();
    await assert.rejects(
      cleanupExecutor.deleteAndVerify('draft-1', TemporaryItemKind.UNSUBMITTED_DRAFT),
      /清理执行器未接线/,
    );
  });

  it('执行清单：全部回读核验 → 完成 + 最小删除审计（不含正文；AUD-006/008）', async () => {
    const rig = makeRig({ ok: true });
    const checklist = await rig.formalDelete.execute(deleteInput);
    const result = await rig.execute.execute(execInput(checklist.checklistId));
    assert.equal(result.completed, true);
    assert.equal(result.checklist.completed, true);
    assert.ok(result.checklist.steps.every((s) => s.status === 'VERIFIED_DELETED'));
    // 最小审计：仅内部标识/时间/超管/类型；不含姓名/正文
    const audit = result.minimalAudit!;
    assert.equal(audit.deletionType, DeletionScopeKind.USER_ALL_DATA);
    assert.equal(audit.performedBy, 'sa1');
    assert.equal(audit.note, 'minimal-audit-only');
    // 最小审计已落库（W2：经 AuditWriter 持久化，杜绝审计丢失）
    assert.equal(rig.writes.length, 1);
    const written = rig.writes[0] as { target: { objectId: string } };
    assert.equal(written.target.objectId, checklist.checklistId);
  });

  it('评审修复：各存储类型生成专属 targetRef（db/storage/cache/index/export 前缀；I1）', async () => {
    const rig = makeRig();
    const checklist = await rig.formalDelete.execute(deleteInput);
    const refs = new Map(checklist.steps.map((s) => [s.kind, s.targetRef]));
    assert.ok(refs.get(DeletionStepKind.ONLINE_DB)!.startsWith('db:'));
    assert.ok(refs.get(DeletionStepKind.ATTACHMENT_STORE)!.startsWith('storage:'));
    assert.ok(refs.get(DeletionStepKind.CACHE)!.startsWith('cache:'));
    assert.ok(refs.get(DeletionStepKind.SEARCH_INDEX)!.startsWith('index:'));
    assert.ok(refs.get(DeletionStepKind.UNEXPIRED_EXPORT)!.startsWith('export:'));
    // 各存储定位引用互不相同
    assert.equal(new Set(checklist.steps.map((s) => s.targetRef)).size, 5);
  });

  it('评审修复：并发执行乐观锁——同一清单并发执行只一个提交成功（W1/IFC-ERR-015）', async () => {
    const rig = makeRig({ ok: true });
    const checklist = await rig.formalDelete.execute(deleteInput);
    const base = await rig.repo.load(checklist.checklistId);
    // 模拟并发：两个执行都基于同一旧版本（v1）构造提交
    const committedSteps = base!.steps.map((s) => ({
      ...s,
      status: DeletionStepStatus.VERIFIED_DELETED,
    }));
    const nextA = { ...base!, steps: committedSteps, completed: true, version: 2 };
    const nextB = { ...base!, steps: committedSteps, completed: true, version: 2 };
    const a = await rig.repo.compareAndSwap(base!, nextA);
    assert.equal(a, true); // 第一个提交成功
    const b = await rig.repo.compareAndSwap(base!, nextB);
    assert.equal(b, false); // 第二个提交失败（版本冲突，防重复删除）
  });

  it('评审修复：审计写入失败 → 普通重试补写审计（auditCommitted 标志，无需 replay 重执行）', async () => {
    const repo = new InMemoryDeletionChecklistRepository();
    const policy = new DeletionPolicy();
    const formalDelete = new FormalDeleteCommand(repo, policy, makeAuditWriterStub().writer);
    const failingAudit = {
      write: async () => {
        throw new Error('audit db down');
      },
    };
    const execute = new ExecuteDeletionChecklistCommand(
      repo,
      { deleteAndVerify: async () => ({ ok: true }) } as never,
      failingAudit as never,
    );
    const checklist = await formalDelete.execute(deleteInput);
    // 审计写入失败 → 命令抛错（调用方知悉审计缺失）；删除步骤已核验完成（事实）
    await assert.rejects(execute.execute(execInput(checklist.checklistId)), /audit db down/);
    const after = await repo.load(checklist.checklistId);
    assert.equal(after!.completed, true); // CAS 已提交（删除完成是事实）
    // 恢复重放可补写审计：换可用审计后 replay 重执行并落审计
    const retryAudit = {
      writes: [] as unknown[],
      write: async (e: unknown) => void retryAudit.writes.push(e),
    };
    const retry = new ExecuteDeletionChecklistCommand(
      repo,
      { deleteAndVerify: async () => ({ ok: true }) } as never,
      retryAudit as never,
    );
    const replayed = await retry.execute(execInput(checklist.checklistId, { replay: true }));
    assert.equal(replayed.completed, true);
    assert.equal(retryAudit.writes.length, 1); // 重放补写 SUCCESS 最小审计
  });

  it('评审修复：审计落库后二次 CAS 失败 → 返回态与持久态一致，普通重试不重复审计', async () => {
    // 构造一个“二次 CAS（置 auditCommitted=true）总失败”的仓储：首次 CAS 成功、
    // 后续任何 compareAndSwap 都失败，模拟他方并发抢先提交，验证不再强制返回 true
    const base = new InMemoryDeletionChecklistRepository();
    const repo = {
      save: (c: DeletionChecklist) => base.save(c),
      load: (id: string) => base.load(id),
      listIncomplete: () => base.listIncomplete(),
      listAll: () => base.listAll(),
      compareAndSwap: async (cur: DeletionChecklist, next: DeletionChecklist) => {
        const latest = await base.load(cur.checklistId);
        if (latest == null || latest.version !== cur.version) return false;
        // 只允许“首次提交执行结果”成功；置 auditCommitted=true 的二次 CAS 一律失败
        if (next.auditCommitted === true) return false;
        await base.save(next);
        return true;
      },
    } as never;
    const policy = new DeletionPolicy();
    const formalDelete = new FormalDeleteCommand(repo, policy, makeAuditWriterStub().writer);
    const audit = makeAuditWriterStub();
    const execute = new ExecuteDeletionChecklistCommand(
      repo,
      { deleteAndVerify: async () => ({ ok: true }) } as never,
      audit.writer,
    );
    const checklist = await formalDelete.execute(deleteInput);
    const result = await execute.execute(execInput(checklist.checklistId));
    assert.equal(result.completed, true);
    // 二次 CAS 失败 → 返回态 auditCommitted 不得强制为 true，应与持久态一致
    assert.equal(result.checklist.auditCommitted, false);
    const persisted = await base.load(checklist.checklistId);
    assert.equal(persisted!.auditCommitted, false);
    // 普通重试：持久态 auditCommitted=false 且已 completed → 继续执行补写审计（非幂等早退）
    const retried = await execute.execute(execInput(checklist.checklistId));
    assert.equal(retried.checklist.auditCommitted, false);
    // 两次执行各写一次 SUCCESS 审计（每次都是真实补写尝试，不静默丢审计）
    assert.equal(audit.writes.length, 2);
  });

  it('部分失败保持未完成：不宣称完成，持续重试（AUD-009/IFC-TX-007）', async () => {
    const rig = makeRig({ ok: false });
    const checklist = await rig.formalDelete.execute(deleteInput);
    const result = await rig.execute.execute(execInput(checklist.checklistId));
    assert.equal(result.completed, false);
    assert.equal(result.checklist.completed, false);
    assert.equal(result.minimalAudit, null); // 未完成不得生成最小审计/宣称完成
    // 部分失败保留尝试审计（AUD-009）：FAILURE 审计已落库（脱敏失败详情）
    assert.equal(rig.writes.length, 1);
    const written = rig.writes[0] as { outcome: string; failureReason: string };
    assert.equal(written.outcome, 'FAILURE');
    assert.equal(written.failureReason, 'deletion-steps-not-verified');
  });

  it('恢复后重放：即使清单已完成也重新执行全部步骤防复现（AUD-009）', async () => {
    const rig = makeRig({ ok: true });
    const checklist = await rig.formalDelete.execute(deleteInput);
    await rig.execute.execute(execInput(checklist.checklistId));
    // 首次完成已落 1 条 SUCCESS 最小审计
    assert.equal(rig.writes.length, 1);
    // 非重放已完成 → 幂等返回（replayCount 不变，不重复审计）
    const idle = await rig.execute.execute(execInput(checklist.checklistId));
    assert.equal(idle.completed, true);
    assert.equal(idle.checklist.replayCount, 0);
    assert.equal(rig.writes.length, 1);
    // 备份恢复后重放（replay=true）：重新执行全部步骤（即使已完成），replayCount 递增；
    // 审计去重：已完成+审计已落清单重放不重复写 SUCCESS 审计（评审意见）
    const replayed = await rig.execute.execute(execInput(checklist.checklistId, { replay: true }));
    assert.equal(replayed.completed, true);
    assert.equal(replayed.checklist.replayCount, 1);
    assert.ok(replayed.checklist.steps.every((s) => s.status === 'VERIFIED_DELETED'));
    assert.equal(rig.writes.length, 1); // 重放不新增审计（去重）
    // 重放后清单仍保持 auditCommitted=true（幂等标志不丢失）
    const reloaded = await rig.repo.load(checklist.checklistId);
    assert.equal(reloaded!.auditCommitted, true);
    // 重放失败 → 保持未完成（恢复数据未彻底清除，不宣称完成）
    const failing = makeRig({ ok: false });
    const c2 = await failing.formalDelete.execute(deleteInput);
    const failedReplay = await failing.execute.execute(execInput(c2.checklistId, { replay: true }));
    assert.equal(failedReplay.completed, false);
    // 全量清单（恢复重放需含已完成清单；AUD-009）
    const all = await rig.query.listAll(['SUPER_ADMIN']);
    assert.equal(all.length, 1); // 含已完成清单
  });

  it('临时清理：过期且无有效引用 → 清理并落审计；有引用/未过期 → 跳过（AUD-007/009）', async () => {
    const rig = makeRig();
    const result = await rig.cleanup.execute({
      items: [
        {
          itemId: 'draft-1',
          kind: TemporaryItemKind.UNSUBMITTED_DRAFT,
          retentionExpired: true,
          hasValidReference: false,
        },
        {
          itemId: 'scan-1',
          kind: TemporaryItemKind.SCAN_FAILED,
          retentionExpired: true,
          hasValidReference: true,
        },
        {
          itemId: 'export-1',
          kind: TemporaryItemKind.TEMPORARY_EXPORT,
          retentionExpired: false,
          hasValidReference: false,
        },
      ],
      audit: { actorId: 'sa1', source: { channel: 'SYSTEM_TASK' }, requestId: 'req-clean' },
    });
    assert.deepEqual(result.cleaned, ['draft-1']);
    assert.deepEqual([...result.skipped].sort(), ['export-1', 'scan-1']);
    // 实际删除项必须落审计留痕（AUD-007/009；评审意见：命令内写审计，杜绝审计缺口）
    assert.equal(rig.cleanupWrites.length, 1);
    const written = rig.cleanupWrites[0] as { target: { objectId: string }; outcome: string };
    assert.equal(written.target.objectId, 'draft-1');
    assert.equal(written.outcome, 'SUCCESS');
  });
});
