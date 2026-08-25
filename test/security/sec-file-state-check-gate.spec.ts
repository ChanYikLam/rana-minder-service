/**
 * 安全控制独立验证：SEC-CTL-017 / SEC-CTL-018 / SEC-CTL-019（文件检查与访问门）。
 *
 * 权威来源：docs/specification/安全设计与实现级威胁模型-v1.0.md §5、§11；
 * FORM-007~009、GOV-008、SRS-SM-FILE-001。
 *
 * 验证路径（真实纯状态机，无 pg/jose 依赖）：
 * - src/modules/file/domain/state-machines/file-state-machine.ts
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  FileCheckOutcome,
  FileState,
  FileStateMachine,
  IllegalFileTransitionError,
} from '../../src/modules/file/domain/state-machines/file-state-machine';

describe('SEC-CTL-017 未完成可信检查不得绑定或访问', () => {
  const machine = new FileStateMachine();

  it('SEC-CTL-017：未检查状态集合（NEW/TEMPORARY_UPLOAD/CHECKING/QUARANTINED_FAILED）一律 isUnsafe', () => {
    for (const state of [
      FileState.NEW,
      FileState.TEMPORARY_UPLOAD,
      FileState.CHECKING,
      FileState.QUARANTINED_FAILED,
    ]) {
      assert.equal(machine.isUnsafe(state), true, state);
    }
    assert.equal(machine.isUnsafe(FileState.AVAILABLE), false);
    assert.equal(machine.isUnsafe(FileState.BOUND_TO_SUBMISSION), false);
  });

  it('SEC-CTL-017：跳过检查直接晋升可用被拒绝（IFC-ERR-006）', () => {
    assert.equal(machine.canTransition(FileState.TEMPORARY_UPLOAD, FileState.AVAILABLE), false);
    assert.throws(
      () => machine.transition(FileState.NEW, FileState.AVAILABLE),
      IllegalFileTransitionError,
    );
    try {
      machine.transition(FileState.TEMPORARY_UPLOAD, FileState.BOUND_TO_SUBMISSION);
      assert.fail('应当抛出 IllegalFileTransitionError');
    } catch (err) {
      assert.match((err as Error).message, /IFC-ERR-006/);
    }
  });

  it('SEC-CTL-017：检查服务不可用保持 CHECKING（可重试），不得超时自动放行', () => {
    assert.equal(FileCheckOutcome.UNAVAILABLE, 'UNAVAILABLE');
    const still = machine.onCheckUnavailable(FileState.CHECKING);
    assert.equal(still, FileState.CHECKING);
    assert.equal(machine.isUnsafe(still), true);
    assert.throws(
      () => machine.onCheckUnavailable(FileState.AVAILABLE),
      IllegalFileTransitionError,
    );
  });

  it('SEC-CTL-017：隔离失败文件不得人工标可用——QUARANTINED_FAILED 仅能进入待清理', () => {
    assert.equal(machine.canTransition(FileState.QUARANTINED_FAILED, FileState.AVAILABLE), false);
    assert.equal(machine.canTransition(FileState.QUARANTINED_FAILED, FileState.CHECKING), false);
    assert.equal(
      machine.canTransition(FileState.QUARANTINED_FAILED, FileState.PENDING_CLEANUP),
      true,
    );
  });
});

describe('SEC-CTL-018 原件/派生版本与每次访问重验边界', () => {
  const machine = new FileStateMachine();

  it('SEC-CTL-018：AVAILABLE 补检失败可回落隔离（旧版本不因历史通过而永久可信）', () => {
    assert.equal(machine.canTransition(FileState.AVAILABLE, FileState.QUARANTINED_FAILED), true);
    assert.equal(machine.isUnsafe(FileState.QUARANTINED_FAILED), true);
  });

  it('SEC-CTL-018：版本替换走重新上传检查路径，不绕过检查晋升', () => {
    assert.equal(machine.canTransition(FileState.AVAILABLE, FileState.TEMPORARY_UPLOAD), true);
    assert.equal(
      machine.isUnsafe(FileState.TEMPORARY_UPLOAD),
      true,
      '替换后的新字节必须重新走完整检查',
    );
  });
});

describe('SEC-CTL-019 撤权先行与删除终态不可复活', () => {
  const machine = new FileStateMachine();

  it('SEC-CTL-019：正式删除经 PENDING_CLEANUP 推进至 FORMALLY_DELETED 终态', () => {
    assert.equal(
      machine.canTransition(FileState.BOUND_TO_SUBMISSION, FileState.PENDING_CLEANUP),
      true,
    );
    assert.equal(
      machine.transition(FileState.PENDING_CLEANUP, FileState.FORMALLY_DELETED),
      FileState.FORMALLY_DELETED,
    );
  });

  it('SEC-CTL-019：已清理/已正式删除为终态，任何复活转换均非法', () => {
    for (const target of [FileState.AVAILABLE, FileState.BOUND_TO_SUBMISSION, FileState.CLEANED]) {
      assert.equal(machine.canTransition(FileState.FORMALLY_DELETED, target), false, target);
      assert.equal(machine.canTransition(FileState.CLEANED, target), false, target);
    }
    assert.throws(
      () => machine.transition(FileState.FORMALLY_DELETED, FileState.AVAILABLE),
      IllegalFileTransitionError,
    );
  });
});
