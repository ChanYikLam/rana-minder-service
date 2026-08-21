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
    ask: new AskFileCheckCommand(repo, store, checkPort),
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

/** 完成上传标准输入（主上传者 u1） */
const completeInput = (file: FileRecord, bytes: Uint8Array, principalId = 'u1') => ({
  fileId: file.fileId,
  sessionId: file.uploadSession!.sessionId,
  principalId,
  bytes,
});

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
    const completed = await flow.complete.execute(completeInput(file, pngBytes()));
    assert.equal(completed.state, FileState.CHECKING);
    assert.equal(completed.checkRecord?.status, 'RUNNING');
    // 隔离区对象存在（只写一次）
    const stored = await flow.store.read(completed.versions[0].objectLocation);
    assert.ok(stored !== null);
    // 重放同一会话 → 拒绝（状态已离开临时上传，拦截更早）
    await assert.rejects(
      flow.complete.execute(completeInput(file, pngBytes())),
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
    const completed = await flow.complete.execute(completeInput(file, exeBytes()));
    assert.equal(completed.state, FileState.QUARANTINED_FAILED);
    // 隔离原因按真实语义：禁止类型（可执行）→ forbidden:，而非误导性的 declared-mismatch
    assert.match(completed.checkRecord!.sanitizedResult, /^forbidden:/);
    const view = await flow.status.getStatus(file.fileId, 'u1');
    assert.equal(view.accessible, false);
  });

  it('检查通过收口：晋升到权威原件区 → 可用（可访问）', async () => {
    const flow = makeFlow();
    const file = await flow.initiate.execute(baseInput);
    await flow.complete.execute(completeInput(file, pngBytes()));
    await flow.ask.execute({
      fileId: file.fileId,
      principalId: 'u1',
    });
    const promoted = await flow.promote.execute({ fileId: file.fileId, principalId: 'u1' });
    assert.equal(promoted.state, FileState.AVAILABLE);
    assert.equal(promoted.versions[0].objectLocation.bucketRole, 'OBJECT');
    const view = await flow.status.getStatus(file.fileId, 'u1');
    assert.equal(view.accessible, true);
    assert.equal(view.checkStatus, 'PASSED');
  });

  it('晋升成功即删除隔离源字节，避免隔离区残留孤儿对象（FORM-009）', async () => {
    const flow = makeFlow();
    const file = await flow.initiate.execute(baseInput);
    const quarantine = file.versions[0].objectLocation; // 晋升前的隔离定位
    await flow.complete.execute(completeInput(file, pngBytes()));
    await flow.ask.execute({ fileId: file.fileId, principalId: 'u1' });
    const promoted = await flow.promote.execute({ fileId: file.fileId, principalId: 'u1' });
    assert.equal(promoted.state, FileState.AVAILABLE);
    assert.equal(promoted.versions[0].objectLocation.bucketRole, 'OBJECT');
    // 权威原件区存在晋升副本，隔离区源字节已删除（copy-then-delete）
    assert.notEqual(await flow.store.read(promoted.versions[0].objectLocation), null);
    assert.equal(await flow.store.read(quarantine), null);
  });

  it('检查失败 → 隔离/失败，可重试标志按结果', async () => {
    const flow = makeFlow();
    // 未知类型字节（octet-stream）→ 初检 FAILED → 隔离失败（声明大小与实际一致）
    const bad = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const file = await flow.initiate.execute({ ...baseInput, declaredSizeBytes: bad.length });
    const completed = await flow.complete.execute(completeInput(file, bad));
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

  it('命令层鉴权：非上传者不得完成上传/请求检查/收口晋升（与状态查询一致）', async () => {
    const flow = makeFlow();
    const file = await flow.initiate.execute(baseInput);
    // 他者完成上传 → 拒绝
    await assert.rejects(flow.complete.execute(completeInput(file, pngBytes(), 'u2')), /无权完成/);
    // 上传者正常完成进入检查中
    await flow.complete.execute(completeInput(file, pngBytes()));
    // 他者请求检查 → 拒绝
    await assert.rejects(
      flow.ask.execute({
        fileId: file.fileId,
        principalId: 'u2',
      }),
      /无权请求/,
    );
    await flow.ask.execute({
      fileId: file.fileId,
      principalId: 'u1',
    });
    // 他者收口晋升 → 拒绝
    await assert.rejects(
      flow.promote.execute({ fileId: file.fileId, principalId: 'u2' }),
      /无权收口/,
    );
    const promoted = await flow.promote.execute({ fileId: file.fileId, principalId: 'u1' });
    assert.equal(promoted.state, FileState.AVAILABLE);
  });

  it('请求检查：字节取自隔离区权威对象并校验可信摘要，调用方不可用任意字节冒充（防绕过）', async () => {
    const flow = makeFlow();
    const file = await flow.initiate.execute(baseInput);
    const completed = await flow.complete.execute(completeInput(file, pngBytes()));
    // 篡改版本记录中的可信 SHA-256 使其与隔离区实际字节不符 → 拒绝执行检查
    const version = completed.versions[completed.versions.length - 1];
    flow.repo.save({
      ...completed,
      versions: [...completed.versions.slice(0, -1), { ...version, sha256: '0'.repeat(64) }],
    });
    await assert.rejects(
      flow.ask.execute({ fileId: file.fileId, principalId: 'u1' }),
      /摘要不一致/,
    );
  });

  it('完成上传：真实 bytes.length 与声明大小不一致时拒绝（防绕过类别硬上限）', async () => {
    const flow = makeFlow();
    const file = await flow.initiate.execute(baseInput);
    // 声明大小与实际真实字节不一致 → 必须拒绝（服务端只信真实字节，不接收客户端自报大小）
    await assert.rejects(
      flow.complete.execute(
        completeInput(file, new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0x00])),
      ),
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

  it('初始化上传：字段附件数量硬上限真正执行（超量拒绝创建，IFC-FIL-001）', async () => {
    const flow = makeFlow();
    // configuredPerField = 2：同一目标字段只允许 2 个附件
    const input = { ...baseInput, configuredPerField: 2 };
    await flow.initiate.execute(input);
    await flow.initiate.execute(input);
    // 已存在 2 个，再创建第 3 个 → 拒绝（listByTarget 统计已有文件数）
    await assert.rejects(flow.initiate.execute(input), /字段附件数量已达上限/);
  });

  it('初始化上传：并发创建不突破字段附件数量上限（防 TOCTOU 竞态）', async () => {
    const flow = makeFlow();
    const input = { ...baseInput, configuredPerField: 2 };
    // 并发 5 个创建同一目标字段，数量上限 2 → 最终成功数不得超过 2
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () => flow.initiate.execute(input)),
    );
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    assert.ok(fulfilled.length <= 2, `并发创建数 ${fulfilled.length} 超过上限 2`);
    assert.equal(fulfilled.length + rejected.length, 5);
    // 仓储内实际保存的目标字段文件数不得超过上限
    const stored = await flow.repo.listByTarget(input.target);
    assert.ok(stored.length <= 2, `仓储内文件数 ${stored.length} 超过上限 2`);
  });

  it('晋升通过：权威原件定位记录 actualSize 使用版本真实大小（非隔离区固定 0）', async () => {
    const flow = makeFlow();
    const file = await flow.initiate.execute(baseInput);
    await flow.complete.execute(completeInput(file, pngBytes()));
    await flow.ask.execute({ fileId: file.fileId, principalId: 'u1' });
    const promoted = await flow.promote.execute({ fileId: file.fileId, principalId: 'u1' });
    assert.equal(promoted.state, FileState.AVAILABLE);
    const loc = promoted.versions[0].objectLocation;
    // 隔离定位记录初始化 actualSize=0，晋升出的权威原件定位须回填真实字节长度
    assert.equal(loc.actualSize, pngBytes().length);
  });

  it('晋升失败：保持检查中(UNAVAILABLE)，清除 finishedAt，不开放访问', async () => {
    const flow = makeFlow();
    const file = await flow.initiate.execute(baseInput);
    await flow.complete.execute(completeInput(file, pngBytes()));
    await flow.ask.execute({
      fileId: file.fileId,
      principalId: 'u1',
    });
    // 预占权威原件区目标键（与隔离区同 randomKey，但 objectKind=OBJECT），令晋升 create-only 失败
    const quarantine = file.versions[0].objectLocation;
    await flow.store.putQuarantine(
      { ...quarantine, bucketRole: 'OBJECT', objectKind: 'OBJECT' },
      new Uint8Array([9, 9, 9]),
    );
    const after = await flow.promote.execute({ fileId: file.fileId, principalId: 'u1' });
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
    const completed = await flow.complete.execute(completeInput(file, pngBytes()));
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
    const after = await flow.promote.execute({ fileId: file.fileId, principalId: 'u1' });
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
    await assert.rejects(flow.complete.execute(completeInput(file, pngBytes())), /上传会话已过期/);
  });
});
