import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AccessPolicy, FileAccessAction } from './access-policy';
import type { FileAccessContext, FileAccessRequest } from './access-policy';

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

describe('AccessPolicy（FORM-008 每次实时鉴权，旧链接不得继续访问）', () => {
  const policy = new AccessPolicy();

  it('未认证 → 拒绝（IFC-ERR-003）', () => {
    const d = policy.check(ctx({ principalId: null }), req(), FileAccessAction.DOWNLOAD, false);
    assert.equal(d.allowed, false);
    assert.equal(d.errorCode, 'IFC-ERR-003');
  });

  it('业务状态非 OPEN（停用/关闭）→ 拒绝（IFC-ERR-003）', () => {
    const d = policy.check(ctx({ businessState: 'SUSPENDED' }), req(), FileAccessAction.DOWNLOAD, false);
    assert.equal(d.allowed, false);
  });

  it('文件状态不安全（检查中/隔离/待清理）→ 拒绝（IFC-ERR-011）', () => {
    for (const st of ['CHECKING', 'QUARANTINED_FAILED', 'PENDING_CLEANUP', 'CLEANED', 'TEMPORARY_UPLOAD']) {
      const d = policy.check(ctx(), req({ fileState: st }), FileAccessAction.DOWNLOAD, false);
      assert.equal(d.allowed, false, `状态 ${st} 应拒绝`);
    }
  });

  it('字段限制：不可预览 → PREVIEW 拒绝；不可下载 → DOWNLOAD 拒绝（不扩大权限）', () => {
    const noPreview = policy.check(ctx(), req({ fieldRestrictions: { previewable: false, downloadable: true } }), FileAccessAction.PREVIEW, false);
    assert.equal(noPreview.allowed, false);
    const noDownload = policy.check(ctx(), req({ fieldRestrictions: { previewable: true, downloadable: false } }), FileAccessAction.DOWNLOAD, false);
    assert.equal(noDownload.allowed, false);
  });

  it('本人历史访问：上传者本人且文件可用 → 放行', () => {
    const d = policy.check(ctx(), req(), FileAccessAction.DOWNLOAD, true);
    assert.equal(d.allowed, true);
  });

  it('ownerOnly 材料：非本人（即使有角色）→ 拒绝', () => {
    const d = policy.check(ctx(), req({ ownerOnly: true }), FileAccessAction.DOWNLOAD, false);
    assert.equal(d.allowed, false);
    assert.equal(d.errorCode, 'IFC-ERR-003');
  });

  it('无有效业务角色（角色为空）→ 拒绝', () => {
    const d = policy.check(ctx({ roles: [] }), req({ ownerOnly: false }), FileAccessAction.DOWNLOAD, false);
    assert.equal(d.allowed, false);
  });

  it('有权业务角色 + 字段允许 → 放行', () => {
    const d = policy.check(ctx({ roles: ['RECRUITMENT_REVIEWER'] }), req({ ownerOnly: false }), FileAccessAction.PREVIEW, false);
    assert.equal(d.allowed, true);
  });
});
