import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AccessPolicy, FileAccessAction } from '../../domain/services/access-policy';
import { FileStateMachine } from '../../domain/state-machines/file-state-machine';
import { WatermarkPolicy } from '../../domain/services/watermark-policy';
import { DefaultSignedUrlProvider } from '../../infrastructure/signed-url-provider';
import { FileAccessQuery, ShortLivedAccessRejectedError } from './file-access.query';
import type { FileAccessContext, FileAccessRequest } from '../../domain/services/access-policy';

const ctx = (overrides: Partial<FileAccessContext> = {}): FileAccessContext => ({
  principalId: 'u1',
  roles: ['CLUB_ADMIN'],
  businessState: 'OPEN',
  ...overrides,
});

const req = (overrides: Partial<FileAccessRequest> = {}): FileAccessRequest => ({
  fileId: 'f1',
  fileState: 'AVAILABLE',
  category: 'PHOTO',
  uploaderId: 'u1',
  target: { objectType: 'FORM_SUBMISSION', objectId: 's1', fieldKey: 'idPhoto' },
  fieldRestrictions: { previewable: true, downloadable: true },
  sensitive: true,
  ownerOnly: false,
  ...overrides,
});

const makeQuery = () => {
  const auditEvents: string[] = [];
  const query = new FileAccessQuery(
    new AccessPolicy(new FileStateMachine()),
    new WatermarkPolicy(),
    new DefaultSignedUrlProvider(),
    { report: async (e: { action: string }) => void auditEvents.push(e.action) },
  );
  return { query, auditEvents };
};

describe('FileAccessQuery（IFC-FIL-005 短时地址/水印/审计）', () => {
  it('实时鉴权拒绝（未认证/隔离/失权）→ 不签发地址', async () => {
    const { query } = makeQuery();
    await assert.rejects(
      query.issueAccess({
        fileId: 'f1',
        context: ctx({ principalId: null }),
        request: req(),
        principalIsUploader: false,
        action: FileAccessAction.DOWNLOAD,
        safeForPreview: false,
      }),
      /IFC-ERR-003/,
    );
    await assert.rejects(
      query.issueAccess({
        fileId: 'f1',
        context: ctx(),
        request: req({ fileState: 'QUARANTINED_FAILED' }),
        principalIsUploader: false,
        action: FileAccessAction.DOWNLOAD,
        safeForPreview: false,
      }),
      /IFC-ERR-011/,
    );
  });

  it('鉴权通过：生成短时地址（含到期）', async () => {
    const { query } = makeQuery();
    const issued = await query.issueAccess({
      fileId: 'f1',
      context: ctx(),
      request: req({ uploaderHistoryVisible: true }),
      principalIsUploader: true,
      action: FileAccessAction.DOWNLOAD,
      safeForPreview: false,
    });
    assert.ok(issued.access.token.length > 0);
    assert.ok(Date.parse(issued.access.expiresAt) > Date.now());
    assert.equal(issued.access.action, FileAccessAction.DOWNLOAD);
  });

  it('短时地址 TTL 有上限：误传超大 ttlMs 被截断到最大有效期', async () => {
    const { query } = makeQuery();
    const issued = await query.issueAccess({
      fileId: 'f1',
      context: ctx(),
      request: req({ uploaderHistoryVisible: true }),
      principalIsUploader: true,
      action: FileAccessAction.DOWNLOAD,
      safeForPreview: false,
      ttlMs: 24 * 60 * 60_000, // 1 天，远超“短时地址”承诺
    });
    const actual = Date.parse(issued.access.expiresAt) - Date.now();
    assert.ok(
      actual <= DefaultSignedUrlProvider.MAX_TTL_MS,
      `实际有效期 ${actual}ms 不得超过 ${DefaultSignedUrlProvider.MAX_TTL_MS}ms`,
    );
  });

  it('敏感附件：水印内容含查看者与时间', async () => {
    const { query } = makeQuery();
    const issued = await query.issueAccess({
      fileId: 'f1',
      context: ctx({ principalId: 'u2' }),
      request: req({ sensitive: true }),
      principalIsUploader: false,
      action: FileAccessAction.PREVIEW,
      safeForPreview: true,
    });
    assert.equal(issued.watermark.required, true);
    assert.ok(issued.watermark.content.includes('u2'));
  });

  it('非安全格式请求预览 → 降级为仅下载（不扩大权限）', async () => {
    const { query } = makeQuery();
    const issued = await query.issueAccess({
      fileId: 'f1',
      context: ctx(),
      request: req({ uploaderHistoryVisible: true }),
      principalIsUploader: true,
      action: FileAccessAction.PREVIEW,
      safeForPreview: false, // 视频等非安全格式
    });
    assert.equal(issued.access.action, FileAccessAction.DOWNLOAD);
  });

  it('非安全格式请求预览但不可下载 → 降级复核拒绝，防止权限放大绕过', async () => {
    const { query } = makeQuery();
    // 字段配置 previewable=true、downloadable=false：可预览但禁止下载
    await assert.rejects(
      query.issueAccess({
        fileId: 'f1',
        context: ctx(),
        request: req({
          uploaderHistoryVisible: true,
          fieldRestrictions: { previewable: true, downloadable: false },
        }),
        principalIsUploader: true,
        action: FileAccessAction.PREVIEW,
        safeForPreview: false, // 视频等非安全格式，会降级为下载
      }),
      /IFC-ERR-011/,
      '降级为下载后仍受 downloadable=false 限制，不得签发下载地址',
    );
  });

  it('非安全格式请求预览且不可下载 → 非本人业务角色同样被复核拒绝', async () => {
    const { query } = makeQuery();
    await assert.rejects(
      query.issueAccess({
        fileId: 'f1',
        context: ctx({ principalId: 'u2' }),
        request: req({
          uploaderId: 'u1',
          fieldRestrictions: { previewable: true, downloadable: false },
        }),
        principalIsUploader: false,
        action: FileAccessAction.PREVIEW,
        safeForPreview: false,
      }),
      /IFC-ERR-011/,
    );
  });

  it('下载及敏感附件预览记录审计；普通预览不记录', async () => {
    const { query, auditEvents } = makeQuery();
    // 非敏感普通预览 → 不审计
    await query.issueAccess({
      fileId: 'f1',
      context: ctx(),
      request: req({ sensitive: false, category: 'VIDEO', uploaderHistoryVisible: true }),
      principalIsUploader: true,
      action: FileAccessAction.PREVIEW,
      safeForPreview: true,
    });
    assert.equal(auditEvents.length, 0);
    // 下载 → 审计
    await query.issueAccess({
      fileId: 'f1',
      context: ctx(),
      request: req({ sensitive: false, uploaderHistoryVisible: true }),
      principalIsUploader: true,
      action: FileAccessAction.DOWNLOAD,
      safeForPreview: false,
    });
    assert.deepEqual(auditEvents, ['DOWNLOAD']);
    // 敏感预览 → 审计
    await query.issueAccess({
      fileId: 'f1',
      context: ctx(),
      request: req({ sensitive: true, uploaderHistoryVisible: true }),
      principalIsUploader: true,
      action: FileAccessAction.PREVIEW,
      safeForPreview: true,
    });
    assert.deepEqual(auditEvents, ['DOWNLOAD', 'PREVIEW']);
  });

  it('本人历史访问：上传者本人 → 放行并签发', async () => {
    const { query } = makeQuery();
    const issued = await query.issueAccess({
      fileId: 'f1',
      context: ctx({ principalId: 'u1' }),
      request: req({ uploaderId: 'u1', uploaderHistoryVisible: true }),
      principalIsUploader: true,
      action: FileAccessAction.DOWNLOAD,
      safeForPreview: false,
    });
    assert.equal(issued.access.action, FileAccessAction.DOWNLOAD);
  });

  it('resolveAccess 接线 verify：有效令牌首次消费通过并返回最小访问能力', async () => {
    const { query } = makeQuery();
    const issued = await query.issueAccess({
      fileId: 'f1',
      context: ctx(),
      request: req({ uploaderHistoryVisible: true }),
      principalIsUploader: true,
      action: FileAccessAction.DOWNLOAD,
      safeForPreview: false,
    });
    const resolved = await query.resolveAccess(issued.access.token);
    assert.equal(resolved.token, issued.access.token);
    assert.equal(resolved.fileId, 'f1');
    assert.equal(resolved.action, FileAccessAction.DOWNLOAD);
  });

  it('resolveAccess 接线 verify：重复消费同一令牌被拒（USED）——一次性语义在消费侧落地', async () => {
    const { query } = makeQuery();
    const issued = await query.issueAccess({
      fileId: 'f1',
      context: ctx(),
      request: req({ uploaderHistoryVisible: true }),
      principalIsUploader: true,
      action: FileAccessAction.PREVIEW,
      safeForPreview: true,
    });
    await query.resolveAccess(issued.access.token); // 首次消费
    await assert.rejects(
      query.resolveAccess(issued.access.token),
      (e: unknown) => e instanceof ShortLivedAccessRejectedError,
      '一次性令牌被消费后不得再次访问',
    );
  });

  it('resolveAccess 接线 verify：未知令牌被拒（UNKNOWN）', async () => {
    const { query } = makeQuery();
    await assert.rejects(
      query.resolveAccess('no-such-token'),
      (e: unknown) => e instanceof ShortLivedAccessRejectedError,
    );
  });
});
