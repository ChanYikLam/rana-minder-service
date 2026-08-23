import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryDeletionChecklistRepository } from '../../infrastructure/deletion-checklist-repository';
import { FormalDeleteCommand } from './formal-delete.command';
import { ExecuteDeletionChecklistCommand } from './execute-deletion-checklist.command';
import { RetentionCleanupCommand } from './retention-cleanup.command';
import { DeletionChecklistQuery } from '../queries/deletion-checklist.query';
import { DeletionPolicy } from '../../domain/services/deletion-policy';
import {
  DeletionScopeKind,
  DeletionStepKind,
  DeletionStepStatus,
  TemporaryItemKind,
} from '../../domain/models/deletion';

const makeRig = (executor: { ok: boolean } = { ok: true }) => {
  const repo = new InMemoryDeletionChecklistRepository();
  const policy = new DeletionPolicy();
  const formalDelete = new FormalDeleteCommand(repo, policy);
  const execute = new ExecuteDeletionChecklistCommand(repo, {
    deleteAndVerify: async () => executor,
  } as never);
  const cleanup = new RetentionCleanupCommand();
  const query = new DeletionChecklistQuery(repo, policy);
  return { repo, formalDelete, execute, cleanup, query };
};

const deleteInput = {
  initiator: { principalId: 'sa1', roles: ['SUPER_ADMIN'] },
  scope: { kind: DeletionScopeKind.USER_ALL_DATA, principalId: 'u1' },
  reason: '用户申请彻底删除本地数据',
  purpose: '合规删除',
  confirmed: true,
  affectedObjects: ['报名:r1', '评价:e1'],
  activeRelations: [],
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
    // 变相匿名化（不建设匿名化；AUD-010）
    await assert.rejects(
      rig.formalDelete.execute({ ...deleteInput, purpose: '匿名化保留统计' }),
      /不建设匿名化/,
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
  });

  it('执行清单：全部回读核验 → 完成 + 最小删除审计（不含正文；AUD-006/008）', async () => {
    const rig = makeRig({ ok: true });
    const checklist = await rig.formalDelete.execute(deleteInput);
    const result = await rig.execute.execute({ checklistId: checklist.checklistId });
    assert.equal(result.completed, true);
    assert.equal(result.checklist.completed, true);
    assert.ok(result.checklist.steps.every((s) => s.status === 'VERIFIED_DELETED'));
    // 最小审计：仅内部标识/时间/超管/类型；不含姓名/正文
    const audit = result.minimalAudit!;
    assert.equal(audit.deletionType, DeletionScopeKind.USER_ALL_DATA);
    assert.equal(audit.performedBy, 'sa1');
    assert.equal(audit.note, 'minimal-audit-only');
  });

  it('部分失败保持未完成：不宣称完成，持续重试（AUD-009/IFC-TX-007）', async () => {
    const rig = makeRig({ ok: false });
    const checklist = await rig.formalDelete.execute(deleteInput);
    const result = await rig.execute.execute({ checklistId: checklist.checklistId });
    assert.equal(result.completed, false);
    assert.equal(result.checklist.completed, false);
    assert.equal(result.minimalAudit, null); // 未完成不得生成最小审计/宣称完成
  });

  it('恢复后重放：即使清单已完成也重新执行全部步骤防复现（AUD-009）', async () => {
    const rig = makeRig({ ok: true });
    const checklist = await rig.formalDelete.execute(deleteInput);
    await rig.execute.execute({ checklistId: checklist.checklistId });
    // 非重放已完成 → 幂等返回（replayCount 不变）
    const idle = await rig.execute.execute({ checklistId: checklist.checklistId });
    assert.equal(idle.completed, true);
    assert.equal(idle.checklist.replayCount, 0);
    // 备份恢复后重放（replay=true）：重新执行全部步骤（即使已完成），replayCount 递增
    const replayed = await rig.execute.execute({
      checklistId: checklist.checklistId,
      replay: true,
    });
    assert.equal(replayed.completed, true);
    assert.equal(replayed.checklist.replayCount, 1);
    assert.ok(replayed.checklist.steps.every((s) => s.status === 'VERIFIED_DELETED'));
    // 重放失败 → 保持未完成（恢复数据未彻底清除，不宣称完成）
    const failing = makeRig({ ok: false });
    const c2 = await failing.formalDelete.execute(deleteInput);
    const failedReplay = await failing.execute.execute({
      checklistId: c2.checklistId,
      replay: true,
    });
    assert.equal(failedReplay.completed, false);
    // 全量清单（恢复重放需含已完成清单；AUD-009）
    const all = await rig.query.listAll(['SUPER_ADMIN']);
    assert.equal(all.length, 1); // 含已完成清单
  });

  it('临时清理：过期且无有效引用 → 清理；有引用/未过期 → 跳过（AUD-007/009）', async () => {
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
    });
    assert.deepEqual(result.cleaned, ['draft-1']);
    assert.deepEqual([...result.skipped].sort(), ['export-1', 'scan-1']);
  });
});
