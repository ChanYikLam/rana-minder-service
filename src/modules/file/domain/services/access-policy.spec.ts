import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AccessPolicy, FileAccessAction } from './access-policy';
import type { FileAccessContext, FileAccessRequest } from './access-policy';
import { FileState, FileStateMachine } from '../state-machines/file-state-machine';

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
  const policy = new AccessPolicy(new FileStateMachine());

  it('未认证 → 拒绝（IFC-ERR-003）', () => {
    const d = policy.check(ctx({ principalId: null }), req(), FileAccessAction.DOWNLOAD, false);
    assert.equal(d.allowed, false);
    assert.equal(d.errorCode, 'IFC-ERR-003');
  });

  it('业务状态非 OPEN（停用/关闭）→ 拒绝（IFC-ERR-003）', () => {
    const d = policy.check(
      ctx({ businessState: 'SUSPENDED' }),
      req(),
      FileAccessAction.DOWNLOAD,
      false,
    );
    assert.equal(d.allowed, false);
  });

  it('文件状态不安全（检查中/隔离/待清理）→ 拒绝（IFC-ERR-011）', () => {
    const unsafeStates: FileState[] = [
      FileState.CHECKING,
      FileState.QUARANTINED_FAILED,
      FileState.PENDING_CLEANUP,
      FileState.CLEANED,
      FileState.TEMPORARY_UPLOAD,
    ];
    for (const st of unsafeStates) {
      const d = policy.check(ctx(), req({ fileState: st }), FileAccessAction.DOWNLOAD, false);
      assert.equal(d.allowed, false, `状态 ${st} 应拒绝`);
    }
  });

  it('字段限制：不可预览 → PREVIEW 拒绝；不可下载 → DOWNLOAD 拒绝（不扩大权限）', () => {
    const noPreview = policy.check(
      ctx(),
      req({ fieldRestrictions: { previewable: false, downloadable: true } }),
      FileAccessAction.PREVIEW,
      false,
    );
    assert.equal(noPreview.allowed, false);
    const noDownload = policy.check(
      ctx(),
      req({ fieldRestrictions: { previewable: true, downloadable: false } }),
      FileAccessAction.DOWNLOAD,
      false,
    );
    assert.equal(noDownload.allowed, false);
  });

  it('本人历史访问：上传者本人且文件可用 → 放行', () => {
    const d = policy.check(
      ctx(),
      req({ uploaderHistoryVisible: true }),
      FileAccessAction.DOWNLOAD,
      true,
    );
    assert.equal(d.allowed, true);
  });

  it('本人历史访问：声称本人但上下文非上传者 → 拒绝（防越权放行）', () => {
    const d = policy.check(
      ctx(),
      req({ uploaderId: 'someone-else' }),
      FileAccessAction.DOWNLOAD,
      true,
    );
    assert.equal(d.allowed, false);
    assert.equal(d.errorCode, 'IFC-ERR-003');
  });

  it('本人历史访问：上传者本人但历史提交不可见 → 拒绝', () => {
    const d = policy.check(
      ctx(),
      req({ uploaderHistoryVisible: false }),
      FileAccessAction.DOWNLOAD,
      true,
    );
    assert.equal(d.allowed, false);
    assert.equal(d.errorCode, 'IFC-ERR-003');
  });

  it('ownerOnly 材料：非本人（即使有角色）→ 拒绝', () => {
    const d = policy.check(ctx(), req({ ownerOnly: true }), FileAccessAction.DOWNLOAD, false);
    assert.equal(d.allowed, false);
    assert.equal(d.errorCode, 'IFC-ERR-003');
  });

  it('无有效业务角色（角色为空）→ 拒绝', () => {
    const d = policy.check(
      ctx({ roles: [] }),
      req({ ownerOnly: false }),
      FileAccessAction.DOWNLOAD,
      false,
    );
    assert.equal(d.allowed, false);
  });

  it('有权业务角色 + 字段允许 → 放行', () => {
    const d = policy.check(
      ctx({ roles: ['RECRUITMENT_REVIEWER'] }),
      req({ ownerOnly: false }),
      FileAccessAction.PREVIEW,
      false,
    );
    assert.equal(d.allowed, true);
  });

  it('目标对象作用域不匹配（即使有角色）→ 拒绝（防误构造 roles 越权）', () => {
    // 目标对象属于 club-a，但当前主体在 club-b
    const d = policy.check(
      ctx({ roles: ['CLUB_ADMIN'], clubId: 'club-b' }),
      req({ ownerOnly: false, objectScope: { clubId: 'club-a' } }),
      FileAccessAction.DOWNLOAD,
      false,
    );
    assert.equal(d.allowed, false);
    assert.equal(d.errorCode, 'IFC-ERR-003');
  });

  it('目标对象作用域匹配（有角色且社团一致）→ 放行', () => {
    const d = policy.check(
      ctx({ roles: ['CLUB_ADMIN'], clubId: 'club-a' }),
      req({ ownerOnly: false, objectScope: { clubId: 'club-a' } }),
      FileAccessAction.DOWNLOAD,
      false,
    );
    assert.equal(d.allowed, true);
  });

  it('目标对象作用域：部门/任务/联合关系不匹配任一 → 拒绝', () => {
    // 部门不匹配
    const byDept = policy.check(
      ctx({ roles: ['MEMBER'], departmentId: 'dept-2' }),
      req({ ownerOnly: false, objectScope: { departmentId: 'dept-1' } }),
      FileAccessAction.DOWNLOAD,
      false,
    );
    assert.equal(byDept.allowed, false);
    // 任务不匹配
    const byTask = policy.check(
      ctx({ roles: ['MEMBER'], taskRef: 'task-2' }),
      req({ ownerOnly: false, objectScope: { taskRef: 'task-1' } }),
      FileAccessAction.DOWNLOAD,
      false,
    );
    assert.equal(byTask.allowed, false);
    // 联合关系不匹配
    const byUnion = policy.check(
      ctx({ roles: ['MEMBER'], unionId: 'union-2' }),
      req({ ownerOnly: false, objectScope: { unionId: 'union-1' } }),
      FileAccessAction.DOWNLOAD,
      false,
    );
    assert.equal(byUnion.allowed, false);
  });

  it('目标对象未声明作用域（全局/无绑定）→ 仅按 roles 与字段放行', () => {
    const d = policy.check(
      ctx({ roles: ['RECRUITMENT_REVIEWER'], clubId: 'club-x' }),
      req({ ownerOnly: false }), // 未传 objectScope
      FileAccessAction.PREVIEW,
      false,
    );
    assert.equal(d.allowed, true);
  });
});
