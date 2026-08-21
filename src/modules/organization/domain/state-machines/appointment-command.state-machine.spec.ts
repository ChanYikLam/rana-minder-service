import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createAppointmentCommand, type AppointmentCommand } from '../models/appointment-command';
import {
  AppointmentCommandStateMachine,
  type AppointmentTransitionInput,
} from './appointment-command.state-machine';

function makeCommand(): AppointmentCommand {
  return createAppointmentCommand({
    id: 'apptcmd-1',
    clubId: 'club-acm-1',
    type: 'appoint',
    content: { subjectId: 'u_d', positionGroup: { owner: 'club-acm', name: '宣传部' } },
    initiator: 'u_b',
    initiatorRoleAtCreate: 'u_b',
    plannedAt: '2026-08-02T00:00:00.000Z',
    now: new Date('2026-08-01T00:00:00.000Z'),
  });
}

function run(
  command: AppointmentCommand,
  event: AppointmentTransitionInput['event'],
  facts: AppointmentTransitionInput['facts'] = {},
  status: AppointmentCommand['status'] = command.status,
  actorRole: string = 'personnel',
) {
  const machine = new AppointmentCommandStateMachine();
  return machine.transition({
    command: { ...command, status },
    event,
    now: new Date('2026-08-01T01:00:00.000Z'),
    actor: 'u_b',
    actorRole,
    facts,
  });
}

describe('AppointmentCommandStateMachine', () => {
  it('create：新建 → 待执行，记录不可变原件 + 通知', () => {
    const r = run(makeCommand(), 'create', {}, 'created');
    assert.equal(r.command.status, 'pending_execution');
    assert.equal(r.command.scheduleVersion, 1);
    assert.ok(r.requiredSideEffects.includes('save_immutable_original'));
  });

  it('schedule_execute：到期正常执行（拿执行租约）', () => {
    const r = run(
      makeCommand(),
      'schedule_execute',
      { due: true, initiatorHasRights: true, preconditions: [{ name: 'member', ok: true }] },
      'pending_execution',
    );
    assert.equal(r.command.status, 'executing');
    assert.equal(r.command.executionLease, 'u_b');
    assert.ok(r.requiredSideEffects.includes('create_relation_execution_task'));
  });

  it('schedule_execute：发起人失权 → 暂停待重新确认', () => {
    const r = run(
      makeCommand(),
      'schedule_execute',
      { due: true, initiatorHasRights: false },
      'pending_execution',
    );
    assert.equal(r.command.status, 'initiator_revoked_pending_reconfirm');
    assert.equal(r.command.revokedEvidence, '2026-08-01T01:00:00.000Z');
  });

  it('schedule_execute：业务前置条件失效 → 暂停待处置（不得自动执行）', () => {
    const r = run(
      makeCommand(),
      'schedule_execute',
      {
        due: true,
        initiatorHasRights: true,
        preconditions: [{ name: 'subject_member', ok: false }],
      },
      'pending_execution',
    );
    assert.equal(r.command.status, 'precondition_invalid_pending_resolution');
    assert.deepEqual(r.command.preconditionSnapshot, [{ name: 'subject_member', ok: false }]);
  });

  it('schedule_execute：未到期 → 拒绝', () => {
    assert.throws(
      () =>
        run(makeCommand(), 'schedule_execute', { initiatorHasRights: true }, 'pending_execution'),
      (e: Error) => e.message.includes('尚未到达执行时间'),
    );
  });

  it('reconfirm：现任管理员确认 → 重新确认待执行，旧调度失效', () => {
    const r = run(
      makeCommand(),
      'reconfirm',
      { confirmerAuthorized: true, newExecTime: '2026-08-03T00:00:00.000Z', preconditions: [] },
      'precondition_invalid_pending_resolution',
      'admin',
    );
    assert.equal(r.command.status, 'reconfirmed_pending_execution');
    assert.equal(r.command.newExecTime, '2026-08-03T00:00:00.000Z');
    assert.ok(r.requiredSideEffects.includes('invalidate_old_schedule'));
    assert.equal(r.command.reconfirmations.length, 1);
    assert.equal(r.command.reconfirmations[0]?.role, 'admin');
    assert.equal(r.command.reconfirmations[0]?.by, 'u_b');
  });

  it('reconfirm：条件未恢复时不得确认', () => {
    assert.throws(
      () =>
        run(
          makeCommand(),
          'reconfirm',
          { confirmerAuthorized: true, preconditions: [{ name: 'm', ok: false }] },
          'precondition_invalid_pending_resolution',
        ),
      (e: Error) => e.message.includes('条件未恢复'),
    );
  });

  it('cancel：待执行可取消；执行中/已生效拒绝', () => {
    const r = run(
      makeCommand(),
      'cancel',
      { cancellerAuthorized: true, reason: '流程调整' },
      'pending_execution',
    );
    assert.equal(r.command.status, 'cancelled');
    assert.equal(r.command.cancelReason, '流程调整');
    assert.throws(
      () => run(makeCommand(), 'cancel', { cancellerAuthorized: true }, 'executing'),
      (e: Error) => (e as { code?: string }).code === 'IFC-ERR-007',
    );
  });

  it('execution_succeeded：回读确认后才正式生效', () => {
    assert.throws(
      () => run(makeCommand(), 'execution_succeeded', { executionResult: undefined }, 'executing'),
      (e: Error) => e.message.includes('回读确认'),
    );
    const r = run(
      makeCommand(),
      'execution_succeeded',
      { executionResult: 'success' },
      'executing',
    );
    assert.equal(r.command.status, 'effective');
    assert.equal(r.command.executionLease, null);
  });

  it('execution_failed：进入执行失败待重试并记录失败尝试', () => {
    const r = run(
      makeCommand(),
      'execution_failed',
      { executionResult: 'failure', reason: 'casdoor timeout' },
      'executing',
    );
    assert.equal(r.command.status, 'exec_failed_pending_retry');
    assert.equal(r.command.failureAttempts.length, 1);
  });

  it('retry_execute：须现任管理员授权', () => {
    assert.throws(
      () =>
        run(
          makeCommand(),
          'retry_execute',
          { confirmerAuthorized: false },
          'exec_failed_pending_retry',
        ),
      (e: Error) => e.message.includes('重新鉴权'),
    );
    const r = run(
      makeCommand(),
      'retry_execute',
      { confirmerAuthorized: true },
      'exec_failed_pending_retry',
    );
    assert.equal(r.command.status, 'executing');
  });
});
