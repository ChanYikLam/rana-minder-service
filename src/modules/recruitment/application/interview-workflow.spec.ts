/**
 * 面试工作流用例集成测试（REC-005 应用层；桩端口）。
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  InMemoryRecruitmentRepository,
  StubRecruitmentAuthorization,
  StubRecruitmentForm,
} from './testing/recruitment-test-support';
import { DefaultCreateRecruitmentActivityUseCase } from './commands/create-recruitment-activity.use-case';
import { DefaultOpenApplicationChannelUseCase } from './commands/open-application-channel.use-case';
import { DefaultSubmitApplicationUseCase } from './commands/submit-application.use-case';
import { InterviewWorkflowUseCase } from './commands/interview-workflow.use-case';
import { InterviewRecord } from '../domain/models/interview-record';
import { RecruitmentActivity } from '../domain/models/recruitment-activity';
import { DefaultRecruitmentActivityStateMachine } from '../domain/state-machines/recruitment-activity.state-machine';

const NOW = new Date('2026-01-01T00:00:00Z');
const CLUB_ID = 'club-1';
const MANAGER = 'manager-1';
const APPLICANT = 'applicant-1';
const INTERVIEWER = 'interviewer-1';

describe('recruitment interview workflow (REC-005)', () => {
  let repo: InMemoryRecruitmentRepository;
  let auth: StubRecruitmentAuthorization;
  let form: StubRecruitmentForm;
  let workflow: InterviewWorkflowUseCase;
  let applicationId: string;

  beforeEach(async () => {
    repo = new InMemoryRecruitmentRepository();
    auth = new StubRecruitmentAuthorization();
    form = new StubRecruitmentForm();
    auth.manageAllowed = true;
    auth.submitAllowed = true;
    workflow = new InterviewWorkflowUseCase(repo, auth);

    const activityId = 'act-1';
    await new DefaultCreateRecruitmentActivityUseCase(repo, auth).execute({
      clubId: CLUB_ID,
      title: '秋招',
      description: null,
      endDate: new Date('2026-12-31T00:00:00Z'),
      actor: MANAGER,
      now: NOW,
      id: activityId,
    });
    const activity = RecruitmentActivity.fromSnapshot((await repo.loadActivity(activityId))!);
    assert.ok(activity.open(new DefaultRecruitmentActivityStateMachine(), NOW));
    await repo.saveActivity(activity.toSnapshot());
    const channelId = 'ch-1';
    await new DefaultOpenApplicationChannelUseCase(repo, auth).execute({
      activityId,
      actor: MANAGER,
      now: NOW,
      id: channelId,
    });
    form.seed({ id: 'sub-1', status: 'SUBMITTED', submittedBy: APPLICANT });
    const result = await new DefaultSubmitApplicationUseCase(repo, auth, form).execute({
      activityId,
      channelId,
      applicantId: APPLICANT,
      departmentChoices: ['dept-a'],
      formRef: { formId: 'form-1', submissionId: 'sub-1', versionNumber: 1 },
      actor: APPLICANT,
      now: NOW,
    });
    applicationId = result.applicationId;
  });

  it('调度→完成→记录评价主链路', async () => {
    const scheduled = await workflow.schedule({
      applicationId,
      roundId: 'round-1',
      interviewerId: INTERVIEWER,
      scheduledAt: NOW,
      location: '线上',
      actor: MANAGER,
      now: NOW,
    });
    assert.strictEqual(scheduled.status, 'SCHEDULED');

    const started = await workflow.start({
      interviewId: scheduled.interviewId,
      actor: MANAGER,
      now: NOW,
    });
    assert.strictEqual(started.status, 'IN_PROGRESS');

    const completed = await workflow.complete({
      interviewId: scheduled.interviewId,
      actor: MANAGER,
      now: NOW,
    });
    assert.strictEqual(completed.status, 'COMPLETED');

    const evaluated = await workflow.recordEvaluation({
      interviewId: scheduled.interviewId,
      values: { score: 5 },
      actor: INTERVIEWER,
      now: NOW,
    });
    assert.strictEqual(evaluated.status, 'COMPLETED');
  });

  it('未开始/未完成的面试不可记录评价（REC_PRECONDITION）', async () => {
    const scheduled = await workflow.schedule({
      applicationId,
      roundId: 'round-1',
      interviewerId: INTERVIEWER,
      scheduledAt: NOW,
      location: null,
      actor: MANAGER,
      now: NOW,
    });
    await assert.rejects(
      () =>
        workflow.recordEvaluation({
          interviewId: scheduled.interviewId,
          values: { score: 5 },
          actor: INTERVIEWER,
          now: NOW,
        }),
      { code: 'REC_PRECONDITION' },
    );
  });

  it('同一申请同轮次重复调度冲突', async () => {
    await workflow.schedule({
      applicationId,
      roundId: 'round-1',
      interviewerId: INTERVIEWER,
      scheduledAt: NOW,
      location: null,
      actor: MANAGER,
      now: NOW,
    });
    await assert.rejects(
      () =>
        workflow.schedule({
          applicationId,
          roundId: 'round-1',
          interviewerId: INTERVIEWER,
          scheduledAt: NOW,
          location: null,
          actor: MANAGER,
          now: NOW,
        }),
      { code: 'REC_CONFLICT' },
    );
  });

  it('面试时间早于当前时间被拒绝', async () => {
    await assert.rejects(
      () =>
        workflow.schedule({
          applicationId,
          roundId: 'round-past',
          interviewerId: INTERVIEWER,
          scheduledAt: new Date('2025-12-31T00:00:00Z'),
          location: null,
          actor: MANAGER,
          now: NOW,
        }),
      { code: 'REC_VALIDATION' },
    );
  });

  it('跳轮须从待选择记录、填原因（SKIPPED）', async () => {
    const pending = InterviewRecord.createPending({
      id: 'iv-p',
      applicationId,
      activityId: (await repo.loadApplication(applicationId))!.activityId,
      clubId: CLUB_ID,
      roundId: 'round-2',
      applicantId: APPLICANT,
      now: NOW,
    });
    await repo.saveInterview(pending.toSnapshot(), -1);
    const skipped = await workflow.skip({
      interviewId: pending.id,
      reason: '免试直录',
      actor: MANAGER,
      now: NOW,
    });
    assert.strictEqual(skipped.status, 'SKIPPED');
  });

  it('跳轮/免试必须填写原因', async () => {
    const pending = InterviewRecord.createPending({
      id: 'iv-skip-empty',
      applicationId,
      activityId: (await repo.loadApplication(applicationId))!.activityId,
      clubId: CLUB_ID,
      roundId: 'round-7',
      applicantId: APPLICANT,
      now: NOW,
    });
    await repo.saveInterview(pending.toSnapshot(), -1);
    await assert.rejects(
      () =>
        workflow.skip({
          interviewId: pending.id,
          reason: '   ',
          actor: MANAGER,
          now: NOW,
        }),
      { code: 'REC_VALIDATION' },
    );
  });

  it('作废保留原始事实（VOIDED）', async () => {
    const scheduled = await workflow.schedule({
      applicationId,
      roundId: 'round-3',
      interviewerId: INTERVIEWER,
      scheduledAt: NOW,
      location: null,
      actor: MANAGER,
      now: NOW,
    });
    const voided = await workflow.void({
      interviewId: scheduled.interviewId,
      actor: MANAGER,
      now: NOW,
    });
    assert.strictEqual(voided.status, 'VOIDED');
  });

  it('作废后重排复用同一记录（VOIDED → SCHEDULED）', async () => {
    const scheduled = await workflow.schedule({
      applicationId,
      roundId: 'round-4',
      interviewerId: INTERVIEWER,
      scheduledAt: NOW,
      location: null,
      actor: MANAGER,
      now: NOW,
    });
    await workflow.void({ interviewId: scheduled.interviewId, actor: MANAGER, now: NOW });
    const rescheduled = await workflow.schedule({
      applicationId,
      roundId: 'round-4',
      interviewerId: 'interviewer-2',
      scheduledAt: NOW,
      location: '线下',
      actor: MANAGER,
      now: NOW,
    });
    assert.strictEqual(rescheduled.interviewId, scheduled.interviewId);
    assert.strictEqual(rescheduled.status, 'SCHEDULED');
  });

  it('暂缓期限不得晚于活动结束且须晚于当前', async () => {
    const pending = InterviewRecord.createPending({
      id: 'iv-h',
      applicationId,
      activityId: (await repo.loadApplication(applicationId))!.activityId,
      clubId: CLUB_ID,
      roundId: 'round-5',
      applicantId: APPLICANT,
      now: NOW,
    });
    await repo.saveInterview(pending.toSnapshot(), -1);
    await assert.rejects(
      () =>
        workflow.hold({
          interviewId: pending.id,
          until: new Date('2027-01-01T00:00:00Z'),
          actor: MANAGER,
          now: NOW,
        }),
      { code: 'REC_VALIDATION' },
    );
    const held = await workflow.hold({
      interviewId: pending.id,
      until: new Date('2026-06-01T00:00:00Z'),
      actor: MANAGER,
      now: NOW,
    });
    assert.strictEqual(held.status, 'HOLD');
  });

  it('暂停恢复后可通过调度端点重新安排（PENDING_SELECTION → SCHEDULED）', async () => {
    const pending = InterviewRecord.createPending({
      id: 'iv-r',
      applicationId,
      activityId: (await repo.loadApplication(applicationId))!.activityId,
      clubId: CLUB_ID,
      roundId: 'round-6',
      applicantId: APPLICANT,
      now: NOW,
    });
    await repo.saveInterview(pending.toSnapshot(), -1);
    const held = await workflow.hold({
      interviewId: pending.id,
      until: new Date('2026-06-01T00:00:00Z'),
      actor: MANAGER,
      now: NOW,
    });
    assert.strictEqual(held.status, 'HOLD');
    const resumed = await workflow.resume({ interviewId: pending.id, actor: MANAGER, now: NOW });
    assert.strictEqual(resumed.status, 'PENDING_SELECTION');

    // 恢复后的待排记录应能通过调度端点复用同一记录编排到 SCHEDULED
    const rescheduled = await workflow.schedule({
      applicationId,
      roundId: 'round-6',
      interviewerId: INTERVIEWER,
      scheduledAt: NOW,
      location: '线上',
      actor: MANAGER,
      now: NOW,
    });
    assert.strictEqual(rescheduled.interviewId, pending.id);
    assert.strictEqual(rescheduled.status, 'SCHEDULED');
  });
});
