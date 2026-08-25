/**
 * FileNestController 传输层回归测试（IFC-FIL-001/003/005）。
 *
 * 安全/契约不变量：
 * - 成功路径统一返回 { code: 0, data } 信封；
 * - 领域错误经 toApiError 脱敏映射：InitiateUploadError(IFC-ERR-006) → 422，
 *   未知错误 → 500 IFC-ERR-016；
 * - 每个端点从 request 解析会话（AuthGuard 逻辑不在本测试范围，桩注入会话）。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { HttpException, HttpStatus } from '@nestjs/common';

import { FileNestController } from './file.nest.controller';
import { AUTH_SESSION_KEY } from '../../../identity/interfaces/nest/auth.guard';
import { InitiateUploadError } from '../../application/commands/initiate-upload.command';
import type { FileRecord } from '../../domain/models/file-model';

function makeController(deps: {
  initiate?: unknown;
  complete?: unknown;
  status?: unknown;
  access?: unknown;
  repo?: unknown;
}): FileNestController {
  return new FileNestController(
    (deps.initiate ?? { execute: async () => ({}) }) as never,
    (deps.complete ?? { execute: async () => ({}) }) as never,
    (deps.status ?? { getStatus: async () => ({ accessible: true }) }) as never,
    (deps.access ?? { issueAccess: async () => ({}) }) as never,
    (deps.repo ?? { load: async () => null }) as never,
  );
}

function sessionRequest(subjectId = 'u1'): Record<string, unknown> {
  return { [AUTH_SESSION_KEY]: { subjectId, now: new Date('2026-01-01T00:00:00Z') } };
}

const fakeRecord = (over: Partial<FileRecord> = {}): FileRecord =>
  ({
    fileId: 'f1',
    uploaderId: 'u1',
    scope: { kind: 'SUBJECT', subjectId: 'u1' },
    category: 'PHOTO',
    state: 'AVAILABLE',
    target: { objectType: 'GENERIC', objectId: 'u1', fieldKey: 'generic' },
    versionNo: 1,
    versions: [
      {
        versionNo: 1,
        objectLocation: {} as never,
        declaredType: 'image/png',
        detectedType: 'image/png',
        declaredSize: 16,
        actualSize: 16,
        sha256: 'x',
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    ],
    uploadSession: { sessionId: 'sess1' } as never,
    checkRecord: null,
    cleanupQueue: [],
    deletionManifest: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...over,
  }) as FileRecord;

describe('FileNestController 传输层', () => {
  it('upload 成功返回 {code:0,data} 且 data 为 FileUploaded 形状', async () => {
    const initiated = fakeRecord({ uploadSession: { sessionId: 'sess1' } as never });
    const completed = fakeRecord();
    const controller = makeController({
      initiate: { execute: async () => initiated },
      complete: { execute: async () => completed },
    });
    const res = await controller.upload(sessionRequest(), {
      name: 'photo.png',
      category: 'PHOTO',
      size: 16,
      mimeType: 'image/png',
      bytes: new Uint8Array([1, 2, 3]),
    });
    assert.equal((res as { code: number }).code, 0);
    const data = (res as { data: Record<string, unknown> }).data;
    assert.equal(data.fileId, 'f1');
    assert.equal(data.name, 'photo.png');
    assert.equal(data.status, 'clean');
    assert.equal(data.size, 16);
  });

  it('getMetadata 成功返回 {code:0,data} 为 FileMetadata 形状', async () => {
    const controller = makeController({
      status: { getStatus: async () => ({ accessible: true, state: 'AVAILABLE' }) },
      repo: { load: async () => fakeRecord() },
    });
    const res = await controller.getMetadata(sessionRequest(), 'f1');
    assert.equal((res as { code: number }).code, 0);
    const data = (res as { data: Record<string, unknown> }).data;
    assert.equal(data.id, 'f1');
    assert.equal(data.status, 'clean');
  });

  it('download 成功返回 {code:0,data} 为 FileDownloadAuthorization 形状', async () => {
    const controller = makeController({
      repo: { load: async () => fakeRecord({ uploaderId: 'u1' }) },
      access: {
        issueAccess: async () => ({
          access: { token: 'tok-abc', expiresAt: '2026-01-01T01:00:00.000Z' },
        }),
      },
    });
    const res = await controller.download(sessionRequest(), 'f1');
    assert.equal((res as { code: number }).code, 0);
    const data = (res as { data: Record<string, unknown> }).data;
    assert.equal(data.fileId, 'f1');
    assert.equal(data.status, 'downloaded');
    assert.equal(data.expiresAt, '2026-01-01T01:00:00.000Z');
  });

  it('upload 抛 InitiateUploadError → 422 IFC-ERR-006（而非 500）', async () => {
    const controller = makeController({
      initiate: { execute: async () => { throw new InitiateUploadError('字段附件数量已达上限'); } },
    });
    let caught: HttpException | undefined;
    try {
      await controller.upload(sessionRequest(), {
        name: 'x.png',
        category: 'PHOTO',
        size: 1,
        bytes: new Uint8Array([1]),
      });
    } catch (e) {
      caught = e as HttpException;
    }
    assert.ok(caught, '应抛出 HttpException');
    assert.equal(caught.getStatus(), HttpStatus.UNPROCESSABLE_ENTITY);
    assert.equal((caught.getResponse() as { code?: string }).code, 'IFC-ERR-006');
  });

  it('未知错误 → 500 IFC-ERR-016 兜底', async () => {
    const controller = makeController({
      initiate: { execute: async () => { throw new Error('boom'); } },
    });
    let caught: HttpException | undefined;
    try {
      await controller.upload(sessionRequest(), {
        name: 'x.png',
        category: 'PHOTO',
        size: 1,
        bytes: new Uint8Array([1]),
      });
    } catch (e) {
      caught = e as HttpException;
    }
    assert.ok(caught, '应抛出 HttpException');
    assert.equal(caught.getStatus(), HttpStatus.INTERNAL_SERVER_ERROR);
    assert.equal((caught.getResponse() as { code?: string }).code, 'IFC-ERR-016');
  });
});
