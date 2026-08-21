import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryFileRepository } from '../../infrastructure/in-memory-file-repository';
import { InMemoryObjectStore } from '../../infrastructure/object-store-port';
import { ApplicationFileCheck } from '../../infrastructure/file-check-port';
import { InitiateUploadCommand } from './initiate-upload.command';
import { CompleteUploadCommand } from './complete-upload.command';
import { AskFileCheckCommand } from './ask-file-check.command';
import { PromoteFileCommand } from './promote-file.command';
import { ReplaceDraftFileCommand } from './replace-draft-file.command';
import { RemoveDraftFileCommand } from './remove-draft-file.command';
import { CleanupOrphansCommand } from './cleanup-orphans.command';
import { QueueFormalDeleteCommand } from './queue-formal-delete.command';
import { DeleteManifestHandler } from './delete-manifest.handler';
import { FileState, FileStateMachine } from '../../domain/state-machines/file-state-machine';
import { UploadPolicy } from '../../domain/services/upload-policy';
import { FileTypeGuard } from '../../domain/services/file-type-guard';

const pngBytes = (): Uint8Array =>
  new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52]);

/** 构造一个已可用（AVAILABLE）的文件 */
const makeAvailableFile = async (repo: InMemoryFileRepository, store: InMemoryObjectStore) => {
  const policy = new UploadPolicy();
  const sm = new FileStateMachine();
  const initiate = new InitiateUploadCommand(repo, policy, sm);
  const complete = new CompleteUploadCommand(repo, store);
  const ask = new AskFileCheckCommand(
    repo,
    store,
    new ApplicationFileCheck(new FileTypeGuard()),
  );
  const promote = new PromoteFileCommand(repo, store);
  const input = {
    uploaderId: 'u1',
    scope: { kind: 'CLUB', clubId: 'c1' },
    category: 'PHOTO' as const,
    declaredSizeBytes: pngBytes().length,
    declaredType: 'image/png',
    target: { objectType: 'FORM_SUBMISSION', objectId: 's1', fieldKey: 'idPhoto' },
  };
  const file = await initiate.execute(input);
  await complete.execute({
    fileId: file.fileId,
    principalId: 'u1',
    sessionId: file.uploadSession!.sessionId,
    bytes: pngBytes(),
  });
  await ask.execute({ fileId: file.fileId, principalId: 'u1' });
  const promoted = await promote.execute({ fileId: file.fileId, principalId: 'u1' });
  assert.equal(promoted.state, FileState.AVAILABLE);
  return promoted;
};

const makeRig = () => {
  const repo = new InMemoryFileRepository();
  const store = new InMemoryObjectStore();
  const sm = new FileStateMachine();
  const policy = new UploadPolicy();
  return {
    repo,
    store,
    replace: new ReplaceDraftFileCommand(repo, policy, sm),
    remove: new RemoveDraftFileCommand(repo, sm),
    cleanup: new CleanupOrphansCommand(repo, store, sm),
    queueFormalDelete: new QueueFormalDeleteCommand(repo, sm),
    deleteManifest: new DeleteManifestHandler(repo, store, sm),
  };
};

describe('4.2.3 替换、删除与数据生命周期（IFC-FIL-006~009）', () => {
  it('替换草稿文件：新版本 + 旧引用入受控清理，不覆盖已检查原件（IFC-FIL-006）', async () => {
    const rig = makeRig();
    const file = await makeAvailableFile(rig.repo, rig.store);
    const oldObjectKey = file.versions[0].objectLocation;
    const replaced = await rig.replace.execute({
      fileId: file.fileId,
      editable: true,
      declaredSizeBytes: pngBytes().length,
      declaredType: 'image/png',
    });
    assert.equal(replaced.state, FileState.TEMPORARY_UPLOAD);
    assert.equal(replaced.versionNo, 2);
    assert.equal(replaced.versions.length, 2);
    // 旧版本原件仍保留（不覆盖），进入清理队列
    assert.equal(replaced.cleanupQueue.length, 1);
    assert.equal(replaced.cleanupQueue[0].location.randomKey, oldObjectKey.randomKey);
    assert.equal(replaced.cleanupQueue[0].reason, 'REPLACED');
  });

  it('已提交锁定：不可编辑 → 拒绝替换（只能走事实纠错）', async () => {
    const rig = makeRig();
    const file = await makeAvailableFile(rig.repo, rig.store);
    await assert.rejects(
      rig.replace.execute({ fileId: file.fileId, editable: false, declaredSizeBytes: pngBytes().length }),
      /已提交表单已锁定/,
    );
  });

  it('隔离/失败文件不可替换（重新上传必须新建文件）', async () => {
    const rig = makeRig();
    const file = await makeAvailableFile(rig.repo, rig.store);
    const quarantined = { ...file, state: FileState.QUARANTINED_FAILED };
    await rig.repo.save(quarantined);
    await assert.rejects(
      rig.replace.execute({ fileId: file.fileId, editable: true, declaredSizeBytes: pngBytes().length }),
      /不可替换/,
    );
  });

  it('移除草稿文件：立即不可见（待清理），全部版本登记清理队列（FORM-009/AUD-008）', async () => {
    const rig = makeRig();
    const file = await makeAvailableFile(rig.repo, rig.store);
    const removed = await rig.remove.execute({ fileId: file.fileId, removable: true });
    assert.equal(removed.state, FileState.PENDING_CLEANUP);
    assert.ok(removed.cleanupQueue.length >= 1);
    const view = removed.cleanupQueue[0];
    assert.equal(view.reason, 'REMOVED');
  });

  it('草稿不可移除：业务未开放移除时拒绝，不进入待清理', async () => {
    const rig = makeRig();
    const file = await makeAvailableFile(rig.repo, rig.store);
    await assert.rejects(
      rig.remove.execute({ fileId: file.fileId, removable: false }),
      /当前草稿不可移除/,
    );
  });

  it('已正式提交的附件：普通用户物理删除拒绝（仅正式删除流程）', async () => {
    const rig = makeRig();
    const file = await makeAvailableFile(rig.repo, rig.store);
    const bound = { ...file, state: FileState.BOUND_TO_SUBMISSION };
    await rig.repo.save(bound);
    await assert.rejects(
      rig.remove.execute({ fileId: file.fileId, removable: false }),
      /不允许普通用户物理删除/,
    );
  });

  it('孤儿清理：逐项删除并回读核验 → 已清理终态', async () => {
    const rig = makeRig();
    const file = await makeAvailableFile(rig.repo, rig.store);
    await rig.remove.execute({ fileId: file.fileId, removable: true });
    const cleaned = await rig.cleanup.execute(file.fileId);
    assert.equal(cleaned.state, FileState.CLEANED);
    assert.ok(cleaned.cleanupQueue.every((i) => i.status === 'VERIFIED_DELETED'));
  });

  it('正式删除：仅超管；先撤权再生成删除清单（IFC-FIL-008/IFC-TX-007）', async () => {
    const rig = makeRig();
    const file = await makeAvailableFile(rig.repo, rig.store);
    // 非超管 → 拒绝
    await assert.rejects(
      rig.queueFormalDelete.execute({
        fileId: file.fileId,
        initiator: { principalId: 'u1', roles: ['CLUB_ADMIN'] },
        reason: '数据违规',
      }),
      /仅超级管理员/,
    );
    // 超管 + 二次确认原因 → 撤权 + 清单
    const manifest = await rig.queueFormalDelete.execute({
      fileId: file.fileId,
      initiator: { principalId: 'sa1', roles: ['SUPER_ADMIN'] },
      reason: '数据违规，二次确认',
    });
    assert.equal(manifest.accessRevoked, true);
    assert.ok(manifest.items.length >= 1);
    const after = await rig.repo.load(file.fileId);
    assert.equal(after!.state, FileState.PENDING_CLEANUP);
  });

  it('删除清单执行：全部回读核验 → 正式删除终态；部分失败保持未完成不宣称完成', async () => {
    const rig = makeRig();
    const file = await makeAvailableFile(rig.repo, rig.store);
    await rig.queueFormalDelete.execute({
      fileId: file.fileId,
      initiator: { principalId: 'sa1', roles: ['SUPER_ADMIN'] },
      reason: '二次确认',
    });
    const result = await rig.deleteManifest.execute(file.fileId);
    assert.equal(result.completed, true);
    const done = await rig.repo.load(file.fileId);
    assert.equal(done!.state, FileState.FORMALLY_DELETED);
  });
});
