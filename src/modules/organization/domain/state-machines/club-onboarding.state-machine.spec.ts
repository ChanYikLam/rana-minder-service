import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createClubSpace, type ClubSpace } from '../models/club-space';
import {
  ClubOnboardingStateMachine,
  type ClubTransitionInput,
} from './club-onboarding.state-machine';

function makeClub(candidate: { owner: string; name: string }) {
  return createClubSpace({
    id: 'club-acm-1',
    name: 'ACM社团',
    description: '',
    candidate,
    actor: 'u_root',
    now: new Date('2026-08-01T00:00:00.000Z'),
  });
}

function transition(
  machine: ClubOnboardingStateMachine,
  overrides: Partial<ClubTransitionInput> & { clubStatus?: ClubSpace['status'] },
) {
  const base: ClubTransitionInput = {
    club: makeClub({ owner: 'club-acm', name: 'ACM社团' }),
    event: 'wizard_save_step',
    actor: 'u_root',
    now: new Date('2026-08-01T01:00:00.000Z'),
    facts: {},
  };
  const merged: ClubTransitionInput = { ...base, ...overrides };
  if (overrides.clubStatus !== undefined)
    merged.club = { ...merged.club, status: overrides.clubStatus };
  return machine.transition(merged);
}

describe('ClubOnboardingStateMachine', () => {
  it('TABLE：每个事件声明了允许的源状态', () => {
    const table = ClubOnboardingStateMachine.TABLE;
    assert.ok(table.wizard_complete.includes('wizard_pending'));
    assert.ok(table.recover.includes('suspended'));
    assert.ok(table.repair.includes('sync_abnormal_readonly'));
    assert.ok(table.rebind.includes('sync_abnormal_readonly'));
    assert.ok(table.reaccess.includes('pending_reaccess'));
  });

  it('wizard_save_step：递增向导步骤', () => {
    const r = transition(new ClubOnboardingStateMachine(), { event: 'wizard_save_step' });
    assert.equal(r.club.wizardStep, 2);
    assert.deepEqual(r.requiredSideEffects, ['save_wizard_draft', 'config_audit']);
  });

  it('wizard_complete：缺二次确认 → 拒绝（IFC-ERR-002）', () => {
    const machine = new ClubOnboardingStateMachine();
    const club = makeClub({ owner: 'club-acm', name: 'ACM社团' });
    assert.throws(
      () =>
        machine.transition({
          club,
          event: 'wizard_complete',
          actor: 'u_root',
          now: new Date(),
          facts: { leaderContinuityOk: true },
        }),
      (e: Error) => (e as { code?: string }).code === 'IFC-ERR-002',
    );
  });

  it('wizard_complete：负责人连续性不足 → 拒绝（ORG-024）', () => {
    const machine = new ClubOnboardingStateMachine();
    const club = makeClub({ owner: 'club-acm', name: 'ACM社团' });
    assert.throws(
      () =>
        machine.transition({
          club,
          event: 'wizard_complete',
          actor: 'u_root',
          now: new Date(),
          facts: { confirmed: true },
        }),
      (e: Error) => e.message.includes('负责人'),
    );
  });

  it('wizard_complete：确认 + 连续 → 启用并登记绑定映射', () => {
    const machine = new ClubOnboardingStateMachine();
    const club = makeClub({ owner: 'club-acm', name: 'ACM社团' });
    const r = machine.transition({
      club,
      event: 'wizard_complete',
      actor: 'u_root',
      now: new Date('2026-08-01T01:00:00.000Z'),
      facts: {
        confirmed: true,
        leaderContinuityOk: true,
        leaderCandidate: { owner: 'club-acm', name: '负责人组' },
      },
    });
    assert.equal(r.club.status, 'enabled');
    assert.equal(r.club.readonly, false);
    assert.deepEqual(r.club.clubGroup, { owner: 'club-acm', name: 'ACM社团' });
    assert.deepEqual(r.club.leaderGroup, { owner: 'club-acm', name: '负责人组' });
    assert.equal(r.club.boundAt, '2026-08-01T01:00:00.000Z');
    const history = r.club.mappingHistory[r.club.mappingHistory.length - 1];
    assert.equal(history.kind, 'bind');
    assert.ok(r.requiredSideEffects.includes('publish_mapping'));
  });

  it('normal_suspend：仍有活跃业务 → 拒绝（ORG-028）', () => {
    assert.throws(
      () =>
        transition(new ClubOnboardingStateMachine(), {
          event: 'normal_suspend',
          clubStatus: 'enabled',
          facts: { hasActiveBusiness: true },
        }),
      (e: Error) => e.message.includes('进行中招新'),
    );
  });

  it('normal_suspend：正常停用保留关系并置只读', () => {
    const machine = new ClubOnboardingStateMachine();
    const club = makeClub({ owner: 'club-acm', name: 'ACM社团' });
    const enabled = machine.transition({
      club: { ...club, status: 'enabled' as const },
      event: 'normal_suspend',
      actor: 'u_root',
      now: new Date('2026-08-01T02:00:00.000Z'),
      facts: {},
    });
    assert.equal(enabled.club.status, 'suspended');
    assert.equal(enabled.club.readonly, true);
    assert.equal(enabled.club.forcedSuspension, false);
    assert.ok(enabled.requiredSideEffects.includes('preserve_casdoor_relations'));
  });

  it('force_suspend：需二次确认；确认后强停并暂停自动截止', () => {
    const machine = new ClubOnboardingStateMachine();
    const club = {
      ...makeClub({ owner: 'club-acm', name: 'ACM社团' }),
      status: 'enabled' as const,
    };
    assert.throws(
      () =>
        machine.transition({
          club,
          event: 'force_suspend',
          actor: 'u_root',
          now: new Date(),
          facts: {},
        }),
      (e: Error) => e.message.includes('强制停用'),
    );
    const r = machine.transition({
      club,
      event: 'force_suspend',
      actor: 'u_root',
      now: new Date('2026-08-01T03:00:00.000Z'),
      facts: { confirmed: true },
    });
    assert.equal(r.club.forcedSuspension, true);
    assert.ok(r.requiredSideEffects.includes('pause_auto_deadlines'));
  });

  it('recover：按实际受阻时长一次性顺延冻结期限', () => {
    const machine = new ClubOnboardingStateMachine();
    const club = {
      ...makeClub({ owner: 'club-acm', name: 'ACM社团' }),
      status: 'suspended' as const,
      freezeStart: '2026-07-30T00:00:00.000Z',
      freezeExtensionMs: 0,
    };
    const r = machine.transition({
      club,
      event: 'recover',
      actor: 'u_root',
      now: new Date('2026-08-01T00:00:00.000Z'),
      facts: { leaderContinuityOk: true, freezeDurationMs: 172800000 },
    });
    assert.equal(r.club.status, 'enabled');
    assert.equal(r.club.freezeExtensionMs, 172800000);
    assert.equal(r.club.freezeStart, null);
    assert.ok(r.requiredSideEffects.includes('extend_frozen_deadlines'));
  });

  it('reconcile_anomaly：须可验证删除/失权才进入同步异常只读', () => {
    const machine = new ClubOnboardingStateMachine();
    const club = {
      ...makeClub({ owner: 'club-acm', name: 'ACM社团' }),
      status: 'enabled' as const,
    };
    assert.throws(
      () =>
        machine.transition({
          club,
          event: 'reconcile_anomaly',
          actor: 'u_root',
          now: new Date(),
          facts: {},
        }),
      (e: Error) => e.message.includes('删除/移动/失权'),
    );
    const r = machine.transition({
      club,
      event: 'reconcile_anomaly',
      actor: 'u_root',
      now: new Date('2026-08-01T04:00:00.000Z'),
      facts: { anomalyDetected: true },
    });
    assert.equal(r.club.status, 'sync_abnormal_readonly');
    assert.equal(r.club.readonly, true);
    assert.ok(r.requiredSideEffects.includes('close_position_permissions'));
  });

  it('repair：原 Group 未恢复可读 → 拒绝；恢复后停用待另行启用', () => {
    const machine = new ClubOnboardingStateMachine();
    const club = {
      ...makeClub({ owner: 'club-acm', name: 'ACM社团' }),
      status: 'sync_abnormal_readonly' as const,
    };
    assert.throws(
      () =>
        machine.transition({ club, event: 'repair', actor: 'u_root', now: new Date(), facts: {} }),
      (e: Error) => e.message.includes('无法修复'),
    );
    const r = machine.transition({
      club,
      event: 'repair',
      actor: 'u_root',
      now: new Date('2026-08-01T05:00:00.000Z'),
      facts: { groupReadable: true, leaderContinuityOk: true },
    });
    assert.equal(r.club.status, 'suspended');
  });

  it('rebind：重置职位/部门映射避免静默扩权（GOV-007）', () => {
    const machine = new ClubOnboardingStateMachine();
    const club = {
      ...makeClub({ owner: 'club-acm', name: 'ACM社团' }),
      status: 'sync_abnormal_readonly' as const,
      leaderGroup: { owner: 'club-acm', name: '负责人组' } as const,
      departmentGroups: [{ owner: 'club-acm', name: '宣传部' }],
    };
    const r = machine.transition({
      club,
      event: 'rebind',
      actor: 'u_root',
      now: new Date('2026-08-01T06:00:00.000Z'),
      facts: { confirmed: true, leaderContinuityOk: true, newGroupRef: { owner: 'club-acm', name: '新社团组' } },
    });
    assert.equal(r.club.status, 'suspended');
    assert.equal(r.club.leaderGroup, null);
    assert.deepEqual(r.club.departmentGroups, []);
    assert.deepEqual(r.club.positionGroups, []);
    assert.deepEqual(r.club.clubGroup, { owner: 'club-acm', name: '新社团组' });
  });

  it('disconnect：有历史 → 待重新接入；无历史 → 关停向导', () => {
    const machine = new ClubOnboardingStateMachine();
    const withHistory = {
      ...makeClub({ owner: 'club-acm', name: 'ACM社团' }),
      status: 'wizard_pending' as const,
      clubGroup: { owner: 'club-acm', name: 'ACM社团' } as const,
    };
    const r1 = machine.transition({
      club: withHistory,
      event: 'disconnect',
      actor: 'u_root',
      now: new Date(),
      facts: { hasHistory: true },
    });
    assert.equal(r1.club.status, 'pending_reaccess');

    const noHistory = { ...makeClub({ owner: 'club-acm', name: 'ACM社团' }), clubGroup: null };
    const r2 = machine.transition({
      club: noHistory,
      event: 'disconnect',
      actor: 'u_root',
      now: new Date(),
      facts: { hasHistory: false },
    });
    assert.equal(r2.club.status, 'wizard_pending');
    assert.equal(r2.club.wizardClosed, true);
  });

  it('非法事件/状态 → IFC-ERR-007', () => {
    const machine = new ClubOnboardingStateMachine();
    const club = makeClub({ owner: 'club-acm', name: 'ACM社团' });
    assert.throws(
      () =>
        machine.transition({
          club,
          event: 'recover',
          actor: 'u_root',
          now: new Date(),
          facts: { leaderContinuityOk: true },
        }),
      (e: Error) => (e as { code?: string }).code === 'IFC-ERR-007',
    );
  });
});
