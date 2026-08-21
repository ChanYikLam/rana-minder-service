/**
 * PostgreSQL 招新仓储行映射单测（4.4 infrastructure；纯函数，不依赖真实库）。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  activityRowToSnapshot,
  channelRowToSnapshot,
  applicationRowToSnapshot,
  departmentPathRowToSnapshot,
  interviewRowToSnapshot,
} from './postgres-recruitment.repository';

const NOW = new Date('2026-01-01T00:00:00Z');

describe('postgres recruitment repository row mapping', () => {
  it('活动行映射', () => {
    const snap = activityRowToSnapshot({
      id: 'a1',
      club_id: 'c1',
      title: '秋招',
      description: null,
      status: 'OPEN',
      paused: false,
      end_date: null,
      created_by: 'm1',
      created_at: NOW,
      updated_at: NOW,
    });
    assert.strictEqual(snap.id, 'a1');
    assert.strictEqual(snap.status, 'OPEN');
    assert.strictEqual(snap.paused, false);
  });

  it('通道行映射（含暂停态）', () => {
    const snap = channelRowToSnapshot({
      id: 'ch1',
      activity_id: 'a1',
      club_id: 'c1',
      status: 'PAUSED',
      open_at: NOW,
      close_at: null,
      min_choices: 1,
      max_choices: 1,
      created_at: NOW,
      updated_at: NOW,
    });
    assert.strictEqual(snap.status, 'PAUSED');
    assert.strictEqual(snap.openAt, NOW);
    assert.strictEqual(snap.closeAt, null);
  });

  it('申请行映射（JSONB 字符串与 null 表单引用）', () => {
    const snap = applicationRowToSnapshot({
      id: 'app1',
      activity_id: 'a1',
      channel_id: 'ch1',
      club_id: 'c1',
      applicant_id: 'u1',
      status: 'SUBMITTED',
      department_choices: '[{"departmentId":"d1","order":1}]',
      form_ref: null,
      qualify_snapshot: '{"ok":true}',
      revision_number: '2',
      revisions: '[{"revision":1}]',
      supplement_due_at: null,
      created_at: NOW,
      updated_at: NOW,
    });
    assert.strictEqual(snap.status, 'SUBMITTED');
    assert.deepStrictEqual(snap.departmentChoices, [{ departmentId: 'd1', order: 1 }]);
    assert.strictEqual(snap.formRef, null);
    assert.deepStrictEqual(snap.qualifySnapshot, { ok: true });
    assert.strictEqual(snap.revisionNumber, 2);
    assert.strictEqual(snap.revisions.length, 1);
  });

  it('部门路径行映射（决定版本与挂起前态）', () => {
    const snap = departmentPathRowToSnapshot({
      id: 'p1',
      application_id: 'app1',
      activity_id: 'a1',
      club_id: 'c1',
      department_id: 'd1',
      status: 'ADMITTED',
      revision_number: '0',
      allow_transfer: false,
      decisions: '[{"decision":"ADMIT","decidedBy":"m1","decidedAt":"2026-01-01T00:00:00.000Z","note":null}]',
      previous_status_before_suspend: null,
      created_at: NOW,
      updated_at: NOW,
    });
    assert.strictEqual(snap.status, 'ADMITTED');
    assert.strictEqual(snap.decisions.length, 1);
    assert.strictEqual(snap.previousStatusBeforeSuspend, null);
  });

  it('面试记录行映射（评价数组与跳过原因）', () => {
    const snap = interviewRowToSnapshot({
      id: 'iv1',
      application_id: 'app1',
      activity_id: 'a1',
      club_id: 'c1',
      round_id: 'r1',
      applicant_id: 'u1',
      status: 'COMPLETED',
      revision_number: '0',
      interviewer_id: 'int1',
      scheduled_at: NOW,
      location: '线上',
      skip_reason: null,
      hold_until: null,
      evaluations: '[{"interviewerId":"int1","values":{"score":5},"decidedAt":"2026-01-01T00:00:00.000Z"}]',
      created_at: NOW,
      updated_at: NOW,
    });
    assert.strictEqual(snap.status, 'COMPLETED');
    assert.strictEqual(snap.roundId, 'r1');
    assert.strictEqual(snap.evaluations.length, 1);
    assert.strictEqual(snap.skipReason, null);
  });
});
