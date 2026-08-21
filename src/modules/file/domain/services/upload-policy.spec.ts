import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { UploadPolicy, DEFAULT_PLATFORM_UPLOAD_LIMITS } from './upload-policy';
import { FileState, FileStateMachine } from '../state-machines/file-state-machine';

describe('UploadPolicy（FORM-007 平台硬上限，管理员不得放宽）', () => {
  const policy = new UploadPolicy();

  it('类别单文件硬上限：照片 10MB/视频 200MB/普通 20MB', () => {
    assert.equal(policy.maxSizeFor('PHOTO'), DEFAULT_PLATFORM_UPLOAD_LIMITS.maxPhotoSizeBytes);
    assert.equal(policy.maxSizeFor('VIDEO'), DEFAULT_PLATFORM_UPLOAD_LIMITS.maxVideoSizeBytes);
    assert.equal(policy.maxSizeFor('GENERIC'), DEFAULT_PLATFORM_UPLOAD_LIMITS.maxGenericSizeBytes);
  });

  it('声明大小超类别上限 → 拒绝', () => {
    assert.throws(() => policy.assertDeclaredSizeWithinLimit('PHOTO', 11 * 1024 * 1024), /硬上限/);
    assert.throws(() => policy.assertDeclaredSizeWithinLimit('VIDEO', 201 * 1024 * 1024), /硬上限/);
  });

  it('声明大小非正 → 拒绝', () => {
    assert.throws(() => policy.assertDeclaredSizeWithinLimit('PHOTO', 0), /必须为正/);
  });

  it('字段附件数量超平台硬上限 → 拒绝（管理员配置同样受约束）', () => {
    assert.throws(() => policy.assertCountWithinLimit(11), /平台硬上限/);
    assert.throws(() => policy.assertCountWithinLimit(0), /必须为正/);
    assert.doesNotThrow(() => policy.assertCountWithinLimit(10));
  });
});

describe('FileStateMachine（SRS-SM-FILE-001 上传检查相关转换）', () => {
  const sm = new FileStateMachine();

  it('合法转换：NEW→临时上传→检查中→可用', () => {
    assert.equal(
      sm.transition(FileState.NEW, FileState.TEMPORARY_UPLOAD),
      FileState.TEMPORARY_UPLOAD,
    );
    assert.equal(sm.transition(FileState.TEMPORARY_UPLOAD, FileState.CHECKING), FileState.CHECKING);
    assert.equal(sm.transition(FileState.CHECKING, FileState.AVAILABLE), FileState.AVAILABLE);
  });

  it('检查失败/隔离：检查中→隔离失败', () => {
    assert.equal(
      sm.transition(FileState.CHECKING, FileState.QUARANTINED_FAILED),
      FileState.QUARANTINED_FAILED,
    );
  });

  it('非法转换：新建→可用 → 拒绝（未检查不得放行）', () => {
    assert.throws(() => sm.transition(FileState.NEW, FileState.AVAILABLE), /IFC-ERR-006/);
    assert.throws(
      () => sm.transition(FileState.TEMPORARY_UPLOAD, FileState.AVAILABLE),
      /IFC-ERR-006/,
    );
  });

  it('未检查状态不可访问（FORM-007）', () => {
    assert.equal(sm.isUnsafe(FileState.NEW), true);
    assert.equal(sm.isUnsafe(FileState.TEMPORARY_UPLOAD), true);
    assert.equal(sm.isUnsafe(FileState.CHECKING), true);
    assert.equal(sm.isUnsafe(FileState.QUARANTINED_FAILED), true);
    assert.equal(sm.isUnsafe(FileState.AVAILABLE), false);
  });

  it('检查服务不可用：保持检查中，不得超时放行（GOV-008/NFR-003）', () => {
    assert.equal(sm.onCheckUnavailable(FileState.CHECKING), FileState.CHECKING);
    assert.throws(() => sm.onCheckUnavailable(FileState.AVAILABLE), /IFC-ERR-006/);
  });
});
