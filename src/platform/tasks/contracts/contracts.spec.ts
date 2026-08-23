import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  TaskStatus,
  TASK_STATUS_SEMANTICS,
  TERMINAL_TASK_STATUSES,
  RUNNABLE_TASK_STATUSES,
  isTerminalTaskStatus,
  isRunnableTaskStatus,
  TaskType,
  TASK_TYPE_OWNER,
  TaskScopeKind,
  taskScopeLabel,
  BatchStatus,
  BatchItemStatus,
  deriveTrackingNumber,
  isTaskSourceVersionCurrent,
} from './index';

describe('TaskStatus', () => {
  it('6 statuses have semantics', () => {
    const statuses = Object.values(TaskStatus);
    assert.equal(statuses.length, 6);
    for (const s of statuses) {
      assert.ok(TASK_STATUS_SEMANTICS[s] !== undefined);
      assert.ok(TASK_STATUS_SEMANTICS[s].length > 0);
    }
  });
  it('terminal only COMPLETED', () => {
    assert.equal(TERMINAL_TASK_STATUSES.size, 1);
    assert.ok(TERMINAL_TASK_STATUSES.has(TaskStatus.COMPLETED));
  });
  it('runnable contains PENDING and RETRYABLE_FAILED', () => {
    assert.equal(RUNNABLE_TASK_STATUSES.size, 2);
    assert.ok(RUNNABLE_TASK_STATUSES.has(TaskStatus.PENDING));
    assert.ok(RUNNABLE_TASK_STATUSES.has(TaskStatus.RETRYABLE_FAILED));
  });
  it('isTerminalTaskStatus', () => {
    assert.equal(isTerminalTaskStatus(TaskStatus.COMPLETED), true);
    assert.equal(isTerminalTaskStatus(TaskStatus.PENDING), false);
    assert.equal(isTerminalTaskStatus(TaskStatus.LEASED), false);
  });
  it('isRunnableTaskStatus', () => {
    assert.equal(isRunnableTaskStatus(TaskStatus.PENDING), true);
    assert.equal(isRunnableTaskStatus(TaskStatus.RETRYABLE_FAILED), true);
    assert.equal(isRunnableTaskStatus(TaskStatus.COMPLETED), false);
  });
});

describe('TaskType', () => {
  it('15 task types have owners', () => {
    const types = Object.values(TaskType);
    assert.equal(types.length, 15);
    for (const t of types) {
      assert.ok(TASK_TYPE_OWNER[t] !== undefined);
      assert.ok(TASK_TYPE_OWNER[t].length > 0);
    }
  });
  it('deriveTrackingNumber format', () => {
    assert.equal(
      deriveTrackingNumber('intent-42', TaskType.FILE_CHECK),
      'task:FILE_CHECK:intent-42',
    );
  });
});

describe('TaskScope', () => {
  it('club label', () => {
    assert.equal(taskScopeLabel({ kind: TaskScopeKind.CLUB, clubId: 'c1' }), 'club:c1');
  });
  it('union label', () => {
    assert.equal(taskScopeLabel({ kind: TaskScopeKind.UNION, unionId: 'u1' }), 'union:u1');
  });
  it('platform label', () => {
    assert.equal(taskScopeLabel({ kind: TaskScopeKind.PLATFORM }), 'platform');
  });
});

describe('TaskSourceRef', () => {
  it('isTaskSourceVersionCurrent', () => {
    const source = {
      objectType: 't',
      objectId: '1',
      version: 5,
      scope: { kind: 'CLUB' as const, clubId: 'c1' },
    };
    assert.equal(isTaskSourceVersionCurrent(source, 5), true);
    assert.equal(isTaskSourceVersionCurrent(source, 3), true);
    assert.equal(isTaskSourceVersionCurrent(source, 6), false);
  });
});

describe('Batch', () => {
  it('BatchStatus 7 statuses', () => {
    assert.equal(Object.values(BatchStatus).length, 7);
  });
  it('BatchItemStatus 5 statuses', () => {
    assert.equal(Object.values(BatchItemStatus).length, 5);
  });
});
