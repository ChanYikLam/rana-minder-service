/**
 * 姓名更正申请状态机单元测试（IDN-016；裁决只一次）。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  DefaultNameCorrectionStateMachine,
  NameCorrectionEvent,
  NameCorrectionState,
} from './name-correction.state-machine';

const machine = new DefaultNameCorrectionStateMachine();

describe('NameCorrectionStateMachine（IDN-016 裁决门）', () => {
  it('SUBMITTED：批准 → APPROVED', () => {
    const result = machine.transition({
      event: NameCorrectionEvent.APPROVE,
      currentState: NameCorrectionState.SUBMITTED,
    });
    assert.equal(result.allowed, true);
    assert.equal(result.nextState, NameCorrectionState.APPROVED);
  });

  it('SUBMITTED：驳回 → REJECTED', () => {
    const result = machine.transition({
      event: NameCorrectionEvent.REJECT,
      currentState: NameCorrectionState.SUBMITTED,
    });
    assert.equal(result.allowed, true);
    assert.equal(result.nextState, NameCorrectionState.REJECTED);
  });

  it('终态：批准后不得再驳回/再批准（裁决只一次）', () => {
    const approved = machine.transition({
      event: NameCorrectionEvent.REJECT,
      currentState: NameCorrectionState.APPROVED,
    });
    assert.equal(approved.allowed, false);

    const rejected = machine.transition({
      event: NameCorrectionEvent.APPROVE,
      currentState: NameCorrectionState.REJECTED,
    });
    assert.equal(rejected.allowed, false);
  });
});
