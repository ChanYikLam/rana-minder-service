/**
 * 部门考察路径领域测试（REC-004）。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { DepartmentPath } from './department-path';
import { DefaultDepartmentPathStateMachine } from '../state-machines/department-path.state-machine';

const NOW = new Date('2026-08-21T12:00:00.000Z');
const MACHINE = new DefaultDepartmentPathStateMachine();

function path(allowTransfer = false) {
  return DepartmentPath.createFromChoice({
    id: 'p1',
    applicationId: 'app1',
    activityId: 'a1',
    clubId: 'c1',
    departmentId: 'd1',
    allowTransfer,
    now: NOW,
  });
}

describe('DepartmentPath (REC-004)', () => {
  it('志愿自动建路径 PENDING', () => {
    assert.equal(path().status, 'PENDING');
  });

  it('晋级 → 部门录取（决策追加版本）', () => {
    const p = path();
    assert.equal(p.recordDecision(MACHINE, 'ADVANCE', 'leader', NOW), true);
    assert.equal(p.status, 'UNDER_REVIEW');
    assert.equal(p.recordDecision(MACHINE, 'ADMIT', 'leader', NOW), true);
    assert.equal(p.status, 'ADMITTED');
    assert.equal(p.toSnapshot().decisions.length, 2);
  });

  it('候补 / 不录取 / 结束本部门路径', () => {
    const p = path();
    assert.equal(p.recordDecision(MACHINE, 'WAITLIST', 'leader', NOW), true);
    assert.equal(p.status, 'WAITLISTED');
    const p2 = path();
    assert.equal(p2.recordDecision(MACHINE, 'REJECT', 'leader', NOW), true);
    assert.equal(p2.status, 'REJECTED');
    const p3 = path();
    p3.recordDecision(MACHINE, 'ADVANCE', 'leader', NOW);
    assert.equal(p3.recordDecision(MACHINE, 'END', 'leader', NOW), true);
    assert.equal(p3.status, 'ENDED');
  });

  it('终态不可再决策', () => {
    const p = path();
    p.recordDecision(MACHINE, 'ADMIT', 'leader', NOW);
    assert.equal(p.recordDecision(MACHINE, 'REJECT', 'leader', NOW), false);
    assert.equal(p.status, 'ADMITTED');
  });

  it('部门 Group 异常：暂停与恢复', () => {
    const p = path();
    p.recordDecision(MACHINE, 'ADVANCE', 'leader', NOW);
    assert.equal(p.suspend(MACHINE, NOW), true);
    assert.equal(p.groupException, true);
    assert.equal(p.status, 'SUSPENDED');
    p.restore(NOW);
    assert.equal(p.status, 'UNDER_REVIEW');
    assert.equal(p.groupException, false);
  });
});
