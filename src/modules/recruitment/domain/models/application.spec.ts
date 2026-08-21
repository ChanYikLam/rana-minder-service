/**
 * 招新申请领域测试（REC-003）。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { Application } from './application';
import { DefaultApplicationStateMachine } from '../state-machines/application.state-machine';
import type { DepartmentChoice } from './application';

const NOW = new Date('2026-08-21T11:00:00.000Z');
const MACHINE = new DefaultApplicationStateMachine();

function draft() {
  return Application.createDraft({
    id: 'app1',
    activityId: 'a1',
    channelId: 'ch1',
    clubId: 'c1',
    applicantId: 'u1',
    now: NOW,
  });
}

function choices(...ids: string[]): DepartmentChoice[] {
  return ids.map((departmentId, index) => ({ departmentId, order: index + 1 }));
}

describe('Application (REC-003)', () => {
  it('草稿 → 提交（志愿合法，生成修订）', () => {
    const app = draft();
    assert.equal(
      app.submit(MACHINE, NOW, {
        departmentChoices: choices('d1', 'd2'),
        formRef: null,
        qualifySnapshot: { eligible: true },
        minChoices: 1,
        maxChoices: 3,
      }),
      true,
    );
    assert.equal(app.status, 'SUBMITTED');
    assert.equal(app.revisionNumber, 1);
  });

  it('志愿重复 → 拒绝', () => {
    const app = draft();
    assert.throws(() =>
      app.submit(MACHINE, NOW, {
        departmentChoices: choices('d1', 'd1'),
        formRef: null,
        qualifySnapshot: null,
        minChoices: 1,
        maxChoices: 3,
      }),
    );
  });

  it('志愿超上限 → 拒绝', () => {
    const app = draft();
    assert.throws(() =>
      app.submit(MACHINE, NOW, {
        departmentChoices: choices('d1', 'd2', 'd3', 'd4'),
        formRef: null,
        qualifySnapshot: null,
        minChoices: 1,
        maxChoices: 3,
      }),
    );
  });

  it('撤回 → 重提（新修订）', () => {
    const app = draft();
    app.submit(MACHINE, NOW, {
      departmentChoices: choices('d1'),
      formRef: null,
      qualifySnapshot: null,
      minChoices: 1,
      maxChoices: 3,
    });
    assert.equal(app.withdraw(NOW), true);
    assert.equal(app.status, 'WITHDRAWN');
    assert.equal(
      app.resubmit(MACHINE, NOW, {
        departmentChoices: choices('d2'),
        formRef: null,
        qualifySnapshot: null,
        minChoices: 1,
        maxChoices: 3,
      }),
      true,
    );
    assert.equal(app.status, 'SUBMITTED');
    assert.equal(app.revisionNumber, 2);
  });

  it('退出后不可重提（终态）', () => {
    const app = draft();
    app.submit(MACHINE, NOW, {
      departmentChoices: choices('d1'),
      formRef: null,
      qualifySnapshot: null,
      minChoices: 1,
      maxChoices: 3,
    });
    assert.equal(app.exit(NOW), true);
    assert.equal(app.status, 'EXITED');
    assert.equal(
      app.resubmit(MACHINE, NOW, {
        departmentChoices: choices('d1'),
        formRef: null,
        qualifySnapshot: null,
        minChoices: 1,
        maxChoices: 3,
      }),
      false,
    );
  });

  it('身份异常标记与恢复', () => {
    const app = draft();
    app.submit(MACHINE, NOW, {
      departmentChoices: choices('d1'),
      formRef: null,
      qualifySnapshot: null,
      minChoices: 1,
      maxChoices: 3,
    });
    const marked = app.markIdentityException(NOW);
    if (!marked) {
      throw new Error('MARK_FAILED status=' + app.status);
    }
    assert.equal(
      app.identityException,
      true,
      'after mark identityException=' + app.identityException,
    );
    assert.equal(app.status, 'IDENTITY_EXCEPTION', 'after mark status=' + app.status);
    const restored = app.restoreIdentity(NOW);
    if (!restored) {
      throw new Error('RESTORE_FAILED status=' + app.status);
    }
    assert.equal(app.status, 'SUBMITTED');
    assert.equal(app.identityException, false);
  });

  it('补充窗口：已提交可开/关（主状态不变）', () => {
    const app = draft();
    app.submit(MACHINE, NOW, {
      departmentChoices: choices('d1'),
      formRef: null,
      qualifySnapshot: null,
      minChoices: 1,
      maxChoices: 3,
    });
    const due = new Date('2026-08-28T00:00:00.000Z');
    app.openSupplement(due, NOW);
    assert.equal(app.supplementDueAt !== null, true);
    assert.equal(app.status, 'SUBMITTED');
    app.closeSupplement(NOW);
    assert.equal(app.supplementDueAt, null);
  });

  it('录取邀请与接受（REC-043/044）：SUBMITTED → ADMITTED → 终态', () => {
    const app = draft();
    app.submit(MACHINE, NOW, {
      departmentChoices: choices('d1'),
      formRef: null,
      qualifySnapshot: null,
      minChoices: 1,
      maxChoices: 3,
    });
    assert.equal(app.sendAdmissionInvitation(NOW), true);
    assert.equal(app.status, 'ADMITTED');
    assert.equal(app.finalReject(NOW), true);
    assert.equal(app.status, 'FINAL_REJECTED');
  });

  it('接受录取须先进入 ADMITTED', () => {
    const app = draft();
    app.submit(MACHINE, NOW, {
      departmentChoices: choices('d1'),
      formRef: null,
      qualifySnapshot: null,
      minChoices: 1,
      maxChoices: 3,
    });
    assert.equal(app.acceptInvitation(NOW), false);
    assert.equal(app.status, 'SUBMITTED');
    assert.equal(app.sendAdmissionInvitation(NOW), true);
    assert.equal(app.acceptInvitation(NOW), true);
    assert.equal(app.status, 'ACCEPTED');
  });
});
