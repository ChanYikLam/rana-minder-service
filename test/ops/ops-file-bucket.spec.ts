/**
 * L5 运维演练门 6：对象存储与文件访问失败关闭（OPS-VER-014 / 015）。
 *
 * 锚点语义（docs/operations/部署运维与恢复手册-v1.0.md §OPS-VER 表）：
 * - OPS-VER-014 三私有 Bucket、只写一次、无在线原生版本和检查/预览：分区隔离、
 *   覆盖拒绝、检查/晋升证据；
 * - OPS-VER-015 文件失权、旧短链、删除和恢复后旧引用失效：当前授权负向重验。
 *
 * 演练方式（真实命令/查询类 + 内存仓储与对象存储，零网络零 sleep）：
 * - 上传链路（InitiateUpload→CompleteUpload→AskFileCheck→PromoteFile）演练
 *   隔离区→权威原件区两分区只写一次流转；
 * - InMemoryObjectStore 覆盖拒绝实弹 + 晋升目标键冲突不放行；
 * - FileAccessQuery 签发短时地址后注入"失权/隔离/业务关闭"，消费时实时鉴权复核拒绝。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { InMemoryFileRepository } from '../../src/modules/file/infrastructure/in-memory-file-repository';
import { InMemoryObjectStore } from '../../src/modules/file/infrastructure/object-store-port';
import { ApplicationFileCheck } from '../../src/modules/file/infrastructure/file-check-port';
import { InitiateUploadCommand } from '../../src/modules/file/application/commands/initiate-upload.command';
import { CompleteUploadCommand } from '../../src/modules/file/application/commands/complete-upload.command';
import { AskFileCheckCommand } from '../../src/modules/file/application/commands/ask-file-check.command';
import { PromoteFileCommand } from '../../src/modules/file/application/commands/promote-file.command';
import { FileStatusQuery } from '../../src/modules/file/application/queries/file-status.query';
import { FileState, FileStateMachine } from '../../src/modules/file/domain/state-machines/file-state-machine';
import { UploadPolicy } from '../../src/modules/file/domain/services/upload-policy';
import { FileTypeGuard } from '../../src/modules/file/domain/services/file-type-guard';

import type { FileAccessContext, FileAccessRequest } from '../../src/modules/file/domain/services/access-policy';
import { AccessPolicy, FileAccessAction } from '../../src/modules/file/domain/services/access-policy';
import { WatermarkPolicy } from '../../src/modules/file/domain/services/watermark-policy';
import { DefaultSignedUrlProvider } from '../../src/modules/file/infrastructure/signed-url-provider';
import {
  FileAccessQuery,
  ShortLivedAccessRejectedError,
} from '../../src/modules/file/application/queries/file-access.query';

const findings = {
  partitionIsolation: false,
  writeOnce: false,
  uncheckedNotAccessible: false,
  staleReferenceDenied: false,
};

const pngBytes = (): Uint8Array =>
  new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  ]);

function makeFlow() {
  const repo = new InMemoryFileRepository();
  const store = new InMemoryObjectStore();
  return {
    repo,
    store,
    initiate: new InitiateUploadCommand(repo, new UploadPolicy(), new FileStateMachine()),
    complete: new CompleteUploadCommand(repo, store),
    ask: new AskFileCheckCommand(repo, store, new ApplicationFileCheck(new FileTypeGuard())),
    promote: new PromoteFileCommand(repo, store),
    status: new FileStatusQuery(repo),
  };
}

const baseInput = {
  uploaderId: 'u1',
  scope: { kind: 'CLUB', clubId: 'c1' },
  category: 'PHOTO' as const,
  declaredSizeBytes: pngBytes().length,
  declaredType: 'image/png',
  target: { objectType: 'FORM_SUBMISSION', objectId: 's1', fieldKey: 'idPhoto' },
  configuredPerField: 3,
};

async function runFullFlow(): Promise<ReturnType<typeof makeFlow>> {
  const flow = makeFlow();
  const file = await flow.initiate.execute(baseInput);
  await flow.complete.execute({
    fileId: file.fileId,
    sessionId: file.uploadSession!.sessionId,
    principalId: 'u1',
    bytes: pngBytes(),
  });
  await flow.ask.execute({ fileId: file.fileId, principalId: 'u1' });
  await flow.promote.execute({ fileId: file.fileId, principalId: 'u1' });
  return flow;
}

/** 走完整链路但保留晋升前中间态（用于断言隔离区源字节删除） */
async function runFullFlowWithIntermediate() {
  const flow = makeFlow();
  const file = await flow.initiate.execute(baseInput);
  const quarantineLoc = file.versions[0].objectLocation;
  await flow.complete.execute({
    fileId: file.fileId,
    sessionId: file.uploadSession!.sessionId,
    principalId: 'u1',
    bytes: pngBytes(),
  });
  await flow.ask.execute({ fileId: file.fileId, principalId: 'u1' });
  const promoted = await flow.promote.execute({ fileId: file.fileId, principalId: 'u1' });
  return { flow, promoted, quarantineLoc };
}

// ----- 门 A：OPS-VER-014 三私有 Bucket / 只写一次 / 检查晋升 -----

describe('OPS-VER-014 三私有 Bucket、只写一次与检查/晋升演练', () => {
  it('分区隔离：字节从隔离区(QUARANTINE)晋升到权威原件区(OBJECT)，源字节删除不残留', async () => {
    const { flow, promoted, quarantineLoc } = await runFullFlowWithIntermediate();
    assert.equal(quarantineLoc.bucketRole, 'QUARANTINE', '初始字节落在隔离区');
    assert.equal(promoted.state, FileState.AVAILABLE);
    assert.equal(promoted.versions[0].objectLocation.bucketRole, 'OBJECT');
    // 晋升后：权威原件区有副本，隔离区无残留（copy-then-delete）
    assert.notEqual(await flow.store.read(promoted.versions[0].objectLocation), null);
    assert.equal(await flow.store.read(quarantineLoc), null, '隔离区源字节必须删除');
    findings.partitionIsolation = true;
  });

  it('只写一次覆盖拒绝：同键二次写入被拒且原字节保持不变（create-only）', async () => {
    const flow = await runFullFlow();
    const all = await flow.repo.listByTarget(baseInput.target);
    const loc = all[0].versions[0].objectLocation;
    const originalBytes = await flow.store.read(loc);
    assert.ok(originalBytes !== null);

    const again = await flow.store.putQuarantine(
      loc,
      new Uint8Array([0xde, 0xad, 0xbe, 0xef]),
    );
    assert.equal(again.ok, false, '同键重复写入必须被拒绝');
    assert.match(again.reason ?? '', /只写一次|已存在/);
    assert.deepEqual(await flow.store.read(loc), originalBytes, '原字节不得被覆盖');
    findings.writeOnce = true;
  });

  it('未检查不可访问：CHECKING / QUARANTINED_FAILED 状态一律 accessible=false', async () => {
    const flow = makeFlow();
    const file = await flow.initiate.execute(baseInput);

    // 完成上传 → CHECKING：不可访问
    await flow.complete.execute({
      fileId: file.fileId,
      sessionId: file.uploadSession!.sessionId,
      principalId: 'u1',
      bytes: pngBytes(),
    });
    const checking = await flow.status.getStatus(file.fileId, 'u1');
    assert.equal(checking.accessible, false);

    // 可执行类型伪装 png → 初检隔离 QUARANTINED_FAILED：不可访问
    const bad = await flow.initiate.execute({
      ...baseInput,
      declaredType: 'image/png',
      declaredSizeBytes: 8,
      target: { ...baseInput.target, fieldKey: 'idPhoto2' },
    });
    await flow.complete.execute({
      fileId: bad.fileId,
      sessionId: bad.uploadSession!.sessionId,
      principalId: 'u1',
      bytes: new Uint8Array([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00]),
    });
    const quarantined = await flow.status.getStatus(bad.fileId, 'u1');
    assert.equal(quarantined.accessible, false);
    assert.equal(quarantined.state, FileState.QUARANTINED_FAILED);

    // 对照组：检查通过晋升后可访问
    const good = await runFullFlowWithIntermediate();
    const okView = await good.flow.status.getStatus(good.promoted.fileId, 'u1');
    assert.equal(okView.checkStatus, 'PASSED');
    findings.uncheckedNotAccessible = true;
  });

  it('演练结论：分区隔离/只写一次/未检查不放行 三证据齐备（结构化汇总）', () => {
    assert.deepEqual(findings, {
      partitionIsolation: true,
      writeOnce: true,
      uncheckedNotAccessible: true,
      staleReferenceDenied: false,
    });
  });
});

// ----- 门 B：OPS-VER-015 失权/旧短链/旧引用失效 -----

function accessCtx(overrides: Partial<FileAccessContext> = {}): FileAccessContext {
  return {
    principalId: 'viewer-ops',
    roles: ['CLUB_ADMIN'],
    businessState: 'OPEN',
    ...overrides,
  };
}

function accessReq(overrides: Partial<FileAccessRequest> = {}): FileAccessRequest {
  return {
    fileId: 'f-ops-015',
    fileState: 'AVAILABLE',
    category: 'VIDEO',
    uploaderId: 'uploader-ops',
    target: { objectType: 'FORM_SUBMISSION', objectId: 's-ops', fieldKey: 'activityVideo' },
    fieldRestrictions: { previewable: true, downloadable: true },
    sensitive: false,
    ownerOnly: false,
    uploaderHistoryVisible: true,
    ...overrides,
  };
}

function makeAccessQuery() {
  const auditEvents: { action: string; sensitive: boolean }[] = [];
  const query = new FileAccessQuery(
    new AccessPolicy(new FileStateMachine()),
    new WatermarkPolicy(),
    new DefaultSignedUrlProvider(),
    {
      report: async (e) => {
        auditEvents.push({ action: e.action, sensitive: e.sensitive });
      },
    },
  );
  return { query, auditEvents };
}

async function issueDownloadToken(): Promise<{
  token: string;
  query: ReturnType<typeof makeAccessQuery>['query'];
}> {
  const { query } = makeAccessQuery();
  const issued = await query.issueAccess({
    fileId: 'f-ops-015',
    context: accessCtx(),
    request: accessReq(),
    principalIsUploader: false,
    action: FileAccessAction.DOWNLOAD,
    safeForPreview: false,
  });
  return { token: issued.access.token, query };
}

describe('OPS-VER-015 文件失权、旧短链和恢复后旧引用失效演练', () => {
  it('主体失权：签发时有效，消费时角色被清空 → 令牌有效仍被实时鉴权拒绝', async () => {
    const { query } = makeAccessQuery();
    // 对照：签发当下令牌可正常消费（拒绝来自实时复核，而非令牌失效）
    const first = await query.issueAccess({
      fileId: 'f-ops-015',
      context: accessCtx(),
      request: accessReq(),
      principalIsUploader: false,
      action: FileAccessAction.DOWNLOAD,
      safeForPreview: false,
    });
    const resolved = await query.resolveAccess(first.access.token);
    assert.equal(resolved.fileId, 'f-ops-015');

    // 失权后签发的短链，在消费时按最新上下文实时复核 → 拒绝
    const second = await query.issueAccess({
      fileId: 'f-ops-015',
      context: accessCtx(),
      request: accessReq(),
      principalIsUploader: false,
      action: FileAccessAction.DOWNLOAD,
      safeForPreview: false,
    });
    await assert.rejects(
      query.resolveAccess(second.access.token, {
        context: accessCtx({ roles: [] }),
        request: accessReq(),
        principalIsUploader: false,
      }),
      /IFC-ERR-003/,
      '失权后旧短链不得继续访问',
    );
    findings.staleReferenceDenied = true;
  });

  it('文件被隔离/删除：消费时最新状态为 unsafe → IFC-ERR-011 拒绝', async () => {
    const { token, query } = await issueDownloadToken();
    await assert.rejects(
      query.resolveAccess(token, {
        context: accessCtx(),
        request: accessReq({ fileState: 'QUARANTINED_FAILED' }),
        principalIsUploader: false,
      }),
      /IFC-ERR-011/,
    );
  });

  it('业务窗口关闭：消费时 businessState=SUSPENDED → 拒绝', async () => {
    const { token, query } = await issueDownloadToken();
    await assert.rejects(
      query.resolveAccess(token, {
        context: accessCtx({ businessState: 'SUSPENDED' }),
        request: accessReq(),
        principalIsUploader: false,
      }),
      /IFC-ERR-003/,
    );
  });

  it('一次性语义：已消费令牌重放被拒（USED）；未知令牌被拒（UNKNOWN）', async () => {
    const { token, query } = await issueDownloadToken();
    await query.resolveAccess(token);
    await assert.rejects(
      query.resolveAccess(token),
      (e: unknown) => e instanceof ShortLivedAccessRejectedError,
      '同一令牌不得二次消费',
    );
    await assert.rejects(
      query.resolveAccess('no-such-token'),
      (e: unknown) => e instanceof ShortLivedAccessRejectedError,
    );
  });

  it('演练结论：文件门全部结束在当前授权判定上（结构化汇总）', () => {
    assert.deepEqual(findings, {
      partitionIsolation: true,
      writeOnce: true,
      uncheckedNotAccessible: true,
      staleReferenceDenied: true,
    });
  });
});
