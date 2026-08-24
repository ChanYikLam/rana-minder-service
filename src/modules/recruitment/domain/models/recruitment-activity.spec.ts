/**
 * 招新活动领域测试（REC-001）。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { RecruitmentActivity } from './recruitment-activity';
import { DefaultRecruitmentActivityStateMachine } from '../state-machines/recruitment-activity.state-machine';

const NOW = new Date('2026-08-21T10:00:00.000Z');
const MACHINE = new DefaultRecruitmentActivityStateMachine();

function draft() {
  return RecruitmentActivity.createDraft({
    id: 'a1',
    clubId: 'c1',
    title: '秋季招新',
    description: null,
    createdBy: 'u1',
    now: NOW,
  });
}

describe('RecruitmentActivity (REC-001)', () => {
  it('DRAFT → OPEN → COMPLETED', () => {
    const activity = draft();
    assert.equal(activity.open(MACHINE, NOW), true);
    assert.equal(activity.status, 'OPEN');
    assert.equal(activity.complete(MACHINE, NOW), true);
    assert.equal(activity.status, 'COMPLETED');
  });

  it('OPEN → CANCELLED', () => {
    const activity = draft();
    activity.open(MACHINE, NOW);
    assert.equal(activity.cancel(MACHINE, NOW), true);
    assert.equal(activity.status, 'CANCELLED');
  });

  it('DRAFT → CANCELLED（SRS-SM-REC-001：草稿或进行中均可取消）', () => {
    const activity = draft();
    assert.equal(activity.cancel(MACHINE, NOW), true);
    assert.equal(activity.status, 'CANCELLED');
  });

  it('DRAFT 不允许 COMPLETE', () => {
    const activity = draft();
    assert.equal(activity.complete(MACHINE, NOW), false);
    assert.equal(activity.status, 'DRAFT');
  });

  it('暂停正交：OPEN 可 pause/resume', () => {
    const activity = draft();
    activity.open(MACHINE, NOW);
    activity.pause(NOW);
    assert.equal(activity.paused, true);
    assert.equal(activity.status, 'OPEN');
    activity.resume(NOW);
    assert.equal(activity.paused, false);
  });

  it('非 OPEN 不可暂停', () => {
    const activity = draft();
    assert.throws(() => activity.pause(NOW));
  });

  it('终态不可再转换', () => {
    const activity = draft();
    activity.open(MACHINE, NOW);
    activity.complete(MACHINE, NOW);
    assert.equal(activity.open(MACHINE, NOW), false);
    assert.equal(activity.status, 'COMPLETED');
  });
});
