import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  RoutineInvitationStateMachine,
  RoutineInvitationStatus as S,
} from './routine-invitation-state-machine';

describe('HIGH_PRIORITY_SYNC_ANOMALY 处置出边（SRS-SM-MEM-004）', () => {
  const sm = new RoutineInvitationStateMachine();
  const a = S.HIGH_PRIORITY_SYNC_ANOMALY;

  it('处置回读确认全部达成 → 已生效', () => {
    assert.equal(sm.canTransition(a, S.ACTIVATED), true);
  });
  it('处置确认可恢复同步 → 已接受待生效', () => {
    assert.equal(sm.canTransition(a, S.ACCEPTED_PENDING_ACTIVATION), true);
  });
  it('处置回读确认已是成员 → 目标已成为成员收口', () => {
    assert.equal(sm.canTransition(a, S.TARGET_ALREADY_MEMBER), true);
  });
  it('冻结普通重试：不得自环重试或回到待处理', () => {
    assert.equal(sm.canTransition(a, a), false);
    assert.equal(sm.canTransition(a, S.PENDING), false);
  });
});
