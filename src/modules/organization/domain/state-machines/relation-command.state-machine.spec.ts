import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createRelationCommand, type RelationCommand } from '../models/relation-command';
import {
  RelationCommandStateMachine,
  type RelationTransitionInput,
} from './relation-command.state-machine';

function makeCommand(): RelationCommand {
  return createRelationCommand({
    id: 'relcmd-1',
    clubId: 'club-acm-1',
    type: 'join_department',
    subjectId: 'u_c',
    originalRelation: [],
    targetRelation: [
      {
        stepId: 's1',
        kind: 'add_member',
        targetGroup: { owner: 'club-acm', name: '宣传部' },
        subjectId: 'u_c',
        idempotencyKey: 'k1',
        order: 0,
        attemptCount: 0,
      },
    ],
    objectVersion: 3,
    idempotencyKey: 'rel:join-dept:u_c',
    submittedBy: 'u_b',
    now: new Date('2026-08-01T00:00:00.000Z'),
  });
}

function run(
  command: RelationCommand,
  event: RelationTransitionInput['event'],
  facts: RelationTransitionInput['facts'],
  status: RelationCommand['status'] = 'pending_execution',
) {
  const machine = new RelationCommandStateMachine();
  return machine.transition({
    command: { ...command, status },
    event,
    now: new Date('2026-08-01T00:05:00.000Z'),
    facts,
  });
}

describe('RelationCommandStateMachine', () => {
  it('submit：待执行 → 处理中，登记执行任务副作用', () => {
    const r = run(makeCommand(), 'submit', {});
    assert.equal(r.command.status, 'processing');
    assert.equal(r.command.attemptCount, 1);
    assert.ok(r.requiredSideEffects.includes('enqueue_execution_task'));
  });

  it('重复 submit → IFC-ERR-007', () => {
    assert.throws(
      () => run(makeCommand(), 'submit', {}, 'processing'),
      (e: Error) => (e as { code?: string }).code === 'IFC-ERR-007',
    );
  });

  it('readback_confirmed：全部目标回读确认后才正式生效', () => {
    const cmd = makeCommand();
    const confirmed = cmd.targetRelation.map((s) => ({ ...s, result: 'confirmed' as const }));
    const r = run(
      cmd,
      'readback_confirmed',
      { readback: { confirmedSteps: confirmed } },
      'processing',
    );
    assert.equal(r.command.status, 'readback_confirmed');
    assert.equal(r.command.confirmedAt, '2026-08-01T00:05:00.000Z');
    assert.ok(r.requiredSideEffects.includes('write_immutable_relation_history'));
  });

  it('readback_confirmed：部分未确认 → 拒绝转成功（IFC-ERR-013）', () => {
    assert.throws(
      () =>
        run(
          makeCommand(),
          'readback_confirmed',
          { readback: { confirmedSteps: [] } },
          'processing',
        ),
      (e: Error) => e.message.includes('未确认'),
    );
  });

  it('retry_attempt：先回读后重试（回读已确认则不重试）', () => {
    const r = run(
      makeCommand(),
      'retry_attempt',
      { retryable: true, withinRetryWindow: true },
      'processing',
    );
    assert.equal(r.command.status, 'processing');
    assert.equal(r.command.attemptCount, 1);
    assert.ok(r.requiredSideEffects.includes('record_backoff'));
  });

  it('retry_attempt：超出 15 分钟窗口 → 拒绝', () => {
    assert.throws(
      () =>
        run(
          makeCommand(),
          'retry_attempt',
          { retryable: true, withinRetryWindow: false },
          'processing',
        ),
      (e: Error) => e.message.includes('15 分钟'),
    );
  });

  it('final_failure：保持原状态并留痕', () => {
    const r = run(makeCommand(), 'final_failure', {}, 'processing');
    assert.equal(r.command.status, 'failed_original_preserved');
    assert.ok(r.command.failureReason?.includes('原关系保持有效'));
  });

  it('partial_write：进入补偿中并按逆序补偿', () => {
    const cmd = makeCommand();
    const r = run(cmd, 'partial_write', {}, 'processing');
    assert.equal(r.command.status, 'processing_compensating');
    const step = r.requiredSideEffects.find((s) => s.startsWith('compensate_in_order:'));
    assert.ok(step);
    assert.ok(step.includes('s1'));
  });

  it('compensation_confirmed：仅补偿中允许，收口后按失败保留原关系', () => {
    const r = run(makeCommand(), 'compensation_confirmed', {}, 'processing_compensating');
    assert.equal(r.command.status, 'failed_original_preserved');
    assert.throws(
      () => run(makeCommand(), 'compensation_confirmed', {}, 'processing'),
      (e: Error) => (e as { code?: string }).code === 'IFC-ERR-007',
    );
  });

  it('create_manual_retry：需重新鉴权后创建人工重试', () => {
    assert.throws(
      () => run(makeCommand(), 'create_manual_retry', {}, 'failed_original_preserved'),
      (e: Error) => e.message.includes('重新鉴权'),
    );
    const r = run(
      makeCommand(),
      'create_manual_retry',
      { manualRetryAuthorized: true },
      'failed_original_preserved',
    );
    assert.equal(r.command.status, 'pending_manual_retry');
  });

  it('manual_retry_executed：重新回读实际关系后再执行', () => {
    const r = run(makeCommand(), 'manual_retry_executed', {}, 'pending_manual_retry');
    assert.equal(r.command.status, 'pending_execution');
    assert.ok(r.requiredSideEffects.includes('readback_actual_relation'));
  });
});
