import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryFileRepository } from '../../infrastructure/in-memory-file-repository';
import { InMemoryObjectStore } from '../../infrastructure/object-store-port';
import { ApplicationFileCheck } from '../../infrastructure/file-check-port';
import { InitiateUploadCommand } from './initiate-upload.command';
import { CompleteUploadCommand } from './complete-upload.command';
import { AskFileCheckCommand } from './ask-file-check.command';
import { PromoteFileCommand } from './promote-file.command';
import { FileStatusQuery } from '../queries/file-status.query';
import { FileState, FileStateMachine } from '../../domain/state-machines/file-state-machine';
import { UploadPolicy } from '../../domain/services/upload-policy';
import { FileTypeGuard } from '../../domain/services/file-type-guard';
import { MAX_SESSION_TTL_MINUTES } from './initiate-upload.command';
import type { FileRecord } from '../../domain/models/file-model';

const pngBytes = (): Uint8Array =>
  new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  ]);

const exeBytes = (): Uint8Array => new Uint8Array([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00]);

const makeFlow = () => {
  const repo = new InMemoryFileRepository();
  const store = new InMemoryObjectStore();
  const checkPort = new ApplicationFileCheck(new FileTypeGuard());
  const policy = new UploadPolicy();
  const sm = new FileStateMachine();
  return {
    repo,
    store,
    initiate: new InitiateUploadCommand(repo, policy, sm),
    complete: new CompleteUploadCommand(repo, store),
    ask: new AskFileCheckCommand(repo, checkPort),
    promote: new PromoteFileCommand(repo, store),
    status: new FileStatusQuery(repo),
  };
};

const baseInput = {
  uploaderId: 'u1',
  scope: { kind: 'CLUB', clubId: 'c1' },
  category: 'PHOTO' as const,
  declaredSizeBytes: pngBytes().length,
  declaredType: 'image/png',
  target: { objectType: 'FORM_SUBMISSION', objectId: 's1', fieldKey: 'idPhoto' },
  configuredPerField: 3,
};

describe('上传与安全检查链路（4.2.1：IFC-FIL-001~003）', () => {
  it('初始化上传：创建文件 + 隔离区限时会话；客户端不得决定对象键', async () => {
    const flow = makeFlow();
    const file = await flow.initiate.execute(baseInput);
    assert.equal(file.state, FileState.TEMPORARY_UPLOAD);
    assert.ok(file.uploadSession);
    assert.ok(file.uploadSession.isolationLocation.randomKey.length >= 36);
    assert.equal(file.versions.length, 1);
    assert.equal(file.versions[0].objectLocation.bucketRole, 'QUARANTINE');
  });

  it('完成上传：隔离区只写一次 + 真实类型初检 → 检查中', async () => {
    const flow = makeFlow();
    const file = await flow.initiate.execute(baseInput);
    const sessionId = file.uploadSession!.sessionId;
    const completed = await flow.complete.execute({
      fileId: file.fileId,
      sessionId,
      bytes: pngBytes(),
      actualSize: pngBytes().length,
    });
    assert.equal(completed.state, FileState.CHECKING);
    assert.equal(completed.checkRecord?.status, 'RUNNING');
    // 隔离区对象存在（只写一次）
    const stored = await flow.store.read(completed.versions[0].objectLocation);
    assert.ok(stored !== null);
    // 重放同一会话 → 拒绝（状态已离开临时上传，拦截更早）
    await assert.rejects(
      flow.complete.execute({
        fileId: file.fileId,
        sessionId,
        bytes: pngBytes(),
        actualSize: pngBytes().length,
      }),
      /不在临时上传状态/,
    );
  });

  it('伪造扩展名（声明 png 实为可执行）→ 初检隔离，不开放访问', async () => {
    const flow = makeFlow();
    const file = await flow.initiate.execute({
      ...baseInput,
      declaredType: 'image/png',
      declaredSizeBytes: exeBytes().length,
    });
    const completed = await flow.complete.execute({
      fileId: file.fileId,
      sessionId: file.uploadSession!.sessionId,
      bytes: exeBytes(),
      actualSize: exeBytes().length,
    });
    assert.equal(completed.state, FileState.QUARANTINED_FAILED);
    const view = await flow.status.getStatus(file.fileId, 'u1');
    assert.equal(view.accessible, false);
  });

  it('检查通过收口：晋升到权威原件区 → 可用（可访问）', async () => {
    const flow = makeFlow();
    const file = await flow.initiate.execute(baseInput);
    await flow.complete.execute({
      fileId: file.fileId,
      sessionId: file.uploadSession!.sessionId,
      bytes: pngBytes(),
      actualSize: pngBytes().length,
    });
    await flow.ask.execute({ fileId: file.fileId, bytes: pngBytes(), declaredType: 'image/png' });
    const promoted = await flow.promote.execute({ fileId: file.fileId });
    assert.equal(promoted.state, FileState.AVAILABLE);
    assert.equal(promoted.versions[0].objectLocation.bucketRole, 'OBJECT');
    const view = await flow.status.getStatus(file.fileId, 'u1');
    assert.equal(view.accessible, true);
    assert.equal(view.checkStatus, 'PASSED');
  });

  it('检查失败 → 隔离/失败，可重试标志按结果', async () => {
    const flow = makeFlow();
    // 未知类型字节（octet-stream）→ 初检 FAILED → 隔离失败（声明大小与实际一致）
    const bad = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const file = await flow.initiate.execute({ ...baseInput, declaredSizeBytes: bad.length });
    const completed = await flow.complete.execute({
      fileId: file.fileId,
      sessionId: file.uploadSession!.sessionId,
      bytes: bad,
      actualSize: bad.length,
    });
    assert.equal(completed.state, FileState.QUARANTINED_FAILED);
    // 隔离原因不把危险内容写入日志（脱敏）
    assert.ok(!completed.checkRecord!.sanitizedResult.includes('danger'));
  });

  it('状态查询：仅上传者可查；他者拒绝（IFC-FIL-003 真实状态）', async () => {
    const flow = makeFlow();
    const file = await flow.initiate.execute(baseInput);
    const view = await flow.status.getStatus(file.fileId, 'u1');
    assert.equal(view.state, FileState.TEMPORARY_UPLOAD);
    await assert.rejects(flow.status.getStatus(file.fileId, 'u2'), /IFC-ERR-003/);
  });

  it('完成上传：真实 bytes.length 与声明大小不一致时拒绝（防绕过类别硬上限）', async () => {
    const flow = makeFlow();
    const file = await flow.initiate.execute(baseInput);
    // actualSize 谎报为声明大小，但真实字节更长 → 必须拒绝
    await assert.rejects(
      flow.complete.execute({
        fileId: file.fileId,
        sessionId: file.uploadSession!.sessionId,
        bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0x00]),
        actualSize: baseInput.declaredSizeBytes,
      }),
      /实际大小与声明大小不一致/,
    );
  });

  it('初始化上传：会话 TTL 超出上限被拒绝（限时会话，不得近乎无限期）', async () => {
    const flow = makeFlow();
    await assert.rejects(
      flow.initiate.execute({ ...baseInput, sessionTtlMinutes: MAX_SESSION_TTL_MINUTES + 1 }),
      /上传会话有效期/,
    );
    await assert.rejects(
      flow.initiate.execute({ ...baseInput, sessionTtlMinutes: 0 }),
      /上传会话有效期/,
    );
  });

  it('晋升失败：保持检查中(UNAVAILABLE)，清除 finishedAt，不开放访问', async () => {
    const flow = makeFlow();
    const file = await flow.initiate.execute(baseInput);
    await flow.complete.execute({
      fileId: file.fileId,
      sessionId: file.uploadSession!.sessionId,
      bytes: pngBytes(),
      actualSize: pngBytes().length,
    });
    await flow.ask.execute({ fileId: file.fileId, bytes: pngBytes(), declaredType: 'image/png' });
    // 预占权威原件区目标键（与隔离区同 randomKey，但 objectKind=OBJECT），令晋升 create-only 失败
    const quarantine = file.versions[0].objectLocation;
    await flow.store.putQuarantine(
      { ...quarantine, bucketRole: 'OBJECT', objectKind: 'OBJECT' },
      new Uint8Array([9, 9, 9]),
    );
    const after = await flow.promote.execute({ fileId: file.fileId });
    assert.equal(after.state, FileState.CHECKING);
    assert.equal(after.checkRecord?.status, 'UNAVAILABLE');
    assert.equal(after.checkRecord?.retryable, true);
    // UNAVAILABLE 为未完成可重试语义，finishedAt 必须清除
    assert.equal(after.checkRecord?.finishedAt, undefined);
    const view = await flow.status.getStatus(file.fileId, 'u1');
    assert.equal(view.accessible, false);
  });

  it('检查服务不可用：保持检查中，可重试，不得自动放行（GOV-008）', async () => {
    const flow = makeFlow();
    const file = await flow.initiate.execute(baseInput);
    const completed = await flow.complete.execute({
      fileId: file.fileId,
      sessionId: file.uploadSession!.sessionId,
      bytes: pngBytes(),
      actualSize: pngBytes().length,
    });
    // 直接置 UNAVAILABLE 检查记录（模拟外部检查服务不可用）
    const unavailable: FileRecord = {
      ...completed,
      checkRecord: {
        fileVersionNo: completed.versionNo,
        engineVersion: 'app-initial-v1',
        status: 'UNAVAILABLE',
        retryable: true,
        sanitizedResult: 'service-unavailable',
        startedAt: new Date().toISOString(),
      },
    };
    flow.repo.save(unavailable);
    // 收口仍保持检查中（不跳转，不写库，不得放行）
    const after = await flow.promote.execute({ fileId: file.fileId });
    assert.equal(after.state, FileState.CHECKING);
    assert.equal(after.checkRecord?.status, 'UNAVAILABLE');
    const view = await flow.status.getStatus(file.fileId, 'u1');
    assert.equal(view.accessible, false);
  });

  it('会话过期：完成上传被拒绝', async () => {
    const flow = makeFlow();
    const file = await flow.initiate.execute(baseInput);
    // 将会话置为已过期
    const expiredSession = { ...file.uploadSession!, expiresAt: '2000-01-01T00:00:00.000Z' };
    flow.repo.save({ ...file, uploadSession: expiredSession });
    await assert.rejects(
      flow.complete.execute({
        fileId: file.fileId,
        sessionId: file.uploadSession!.sessionId,
        bytes: pngBytes(),
        actualSize: pngBytes().length,
      }),
      /上传会话已过期/,
    );
  });
});
