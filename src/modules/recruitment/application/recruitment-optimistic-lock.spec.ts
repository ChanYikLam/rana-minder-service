/**
 * 乐观锁回归测试（recruitment optimistic-lock；4.4 评审修复 #3）。
 *
 * 验证内存仓储 save* 对 Application / InterviewRecord / DepartmentPath 的
 * expectedRevision 守卫：期望值不匹配时抛 REC_CONFLICT，匹配时成功。
 * PostgreSQL 仓储沿用相同 upsert-with-guard 语义（UPDATE WHERE revision_number）。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { InMemoryRecruitmentRepository } from './testing/recruitment-test-support';
import { Application } from '../domain/models/application';
import { InterviewRecord } from '../domain/models/interview-record';
import { DepartmentPath } from '../domain/models/department-path';

const NOW = new Date('2026-06-01T09:00:00Z');

describe('recruitment optimistic-lock guards (REC-043/044, REC-005, REC-004)', () => {
  it('saveApplication 拒绝过期 expectedRevision', async () => {
    const repo = new InMemoryRecruitmentRepository();
    const app = Application.createDraft({
      id: 'a1',
      activityId: 'act',
      channelId: 'ch',
      clubId: 'club',
      applicantId: 'u1',
      now: NOW,
    });
    await repo.saveApplication(app.toSnapshot(), -1);
    const snap = (await repo.loadApplication(app.id))!;
    assert.strictEqual(snap.revisionNumber, 0);
    await assert.rejects(() => repo.saveApplication(snap, 5), { code: 'REC_CONFLICT' });
    await repo.saveApplication(snap, 0);
  });

  it('saveInterview 拒绝过期 expectedRevision', async () => {
    const repo = new InMemoryRecruitmentRepository();
    const iv = InterviewRecord.createPending({
      id: 'iv1',
      applicationId: 'a1',
      activityId: 'act',
      clubId: 'club',
      roundId: 'r1',
      applicantId: 'u1',
      now: NOW,
    });
    await repo.saveInterview(iv.toSnapshot(), -1);
    const snap = (await repo.loadInterview(iv.id))!;
    assert.strictEqual(snap.revisionNumber, 0);
    await assert.rejects(() => repo.saveInterview(snap, 3), { code: 'REC_CONFLICT' });
    await repo.saveInterview(snap, 0);
  });

  it('saveDepartmentPath 拒绝过期 expectedRevision', async () => {
    const repo = new InMemoryRecruitmentRepository();
    const dp = DepartmentPath.createFromChoice({
      id: 'dp1',
      applicationId: 'a1',
      activityId: 'act',
      clubId: 'club',
      departmentId: 'dept-a',
      allowTransfer: false,
      now: NOW,
    });
    await repo.saveDepartmentPath(dp.toSnapshot(), -1);
    const snap = (await repo.loadDepartmentPath(dp.id))!;
    assert.strictEqual(snap.revisionNumber, 0);
    await assert.rejects(() => repo.saveDepartmentPath(snap, 7), { code: 'REC_CONFLICT' });
    await repo.saveDepartmentPath(snap, 0);
  });
});
