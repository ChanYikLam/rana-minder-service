/**
 * 报名草稿/撤销/退出用例测试（A2；SM-REC-003，接口清单 §11.1）。
 *
 * 覆盖：
 * - 草稿：无申请创建 DRAFT、已有草稿更新 answers（revision 递增）、SUBMITTED 拒绝、
 *   冒充拒绝；
 * - 撤销提交回草稿：SUBMITTED→WITHDRAWN、面试安排守卫、撤销后可继续编辑草稿；
 * - 退出招新：confirm 二次确认、ACCEPTED 拒绝、SUBMITTED→EXITED。
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
import { DefaultSaveApplicationDraftUseCase } from './commands/save-application-draft.use-case';
import { DefaultWithdrawApplicationUseCase } from './commands/withdraw-application.use-case';
import { DefaultExitRecruitmentUseCase } from './commands/exit-recruitment.use-case';
import { RecruitmentActivity } from '../domain/models/recruitment-activity';
import { DefaultRecruitmentActivityStateMachine } from '../domain/state-machines/recruitment-activity.state-machine';
import { InterviewRecord } from '../domain/models/interview-record';
import { DefaultInterviewRecordStateMachine } from '../domain/state-machines/interview-record.state-machine';

const NOW = new Date('2026-01-01T00:00:00Z');
const CLUB_ID = 'club-1';
const ACTOR = 'manager-1';
const APPLICANT = 'applicant-1';
const ACTIVITY_ID = 'act-a2';
const CHANNEL_ID = 'ch-a2';

interface Harness {
  repo: InMemoryRecruitmentRepository;
  draft: DefaultSaveApplicationDraftUseCase;
  withdraw: DefaultWithdrawApplicationUseCase;
  exit: DefaultExitRecruitmentUseCase;
  submit: DefaultSubmitApplicationUseCase;
}

async function makeHarness(): Promise<Harness> {
  const repo = new InMemoryRecruitmentRepository();
  const auth = new StubRecruitmentAuthorization();
  auth.manageAllowed = true;
  auth.submitAllowed = true;

  const create = new DefaultCreateRecruitmentActivityUseCase(repo, auth);
  await create.execute({
    clubId: CLUB_ID,
    title: '秋招',
    description: null,
    actor: ACTOR,
    now: NOW,
    id: ACTIVITY_ID,
  });
  const activity = RecruitmentActivity.fromSnapshot((await repo.loadActivity(ACTIVITY_ID))!);
  assert.ok(activity.open(new DefaultRecruitmentActivityStateMachine(), NOW), '活动开放失败');
  await repo.saveActivity(activity.toSnapshot());
  const openChannel = new DefaultOpenApplicationChannelUseCase(repo, auth);
  await openChannel.execute({
    activityId: ACTIVITY_ID,
    minChoices: 1,
    maxChoices: 3,
    actor: ACTOR,
    now: NOW,
    id: CHANNEL_ID,
  });

  const form = new StubRecruitmentForm();
  return {
    repo,
    draft: new DefaultSaveApplicationDraftUseCase(repo),
    withdraw: new DefaultWithdrawApplicationUseCase(repo),
    exit: new DefaultExitRecruitmentUseCase(repo),
    submit: new DefaultSubmitApplicationUseCase(repo, auth, form),
  };
}

/** 场景快捷方式：以申请人身份保存一次草稿。 */
function saveDraft(h: Harness, answers: unknown, at = NOW): Promise<{ applicationId: string }> {
  return h.draft.execute({
    activityId: ACTIVITY_ID,
    channelId: CHANNEL_ID,
    applicantId: APPLICANT,
    actor: APPLICANT,
    answers,
    now: at,
  });
}

describe('A2 报名草稿（saveApplicationDraft）', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await makeHarness();
  });

  it('无申请 → 创建 DRAFT 并保存 answers', async () => {
    await saveDraft(h, { intro: '你好' });
    const row = await h.repo.loadApplicationByApplicantAndChannel(APPLICANT, CHANNEL_ID);
    assert.ok(row);
    assert.equal(row!.status, 'DRAFT');
    const snapshot = (row!.qualifySnapshot ?? {}) as { answers?: { intro: string } };
    assert.equal(snapshot.answers?.intro, '你好');
  });

  it('已有草稿 → 更新 answers（revision 递增）', async () => {
    await saveDraft(h, { v: 1 });
    const before = (await h.repo.loadApplicationByApplicantAndChannel(APPLICANT, CHANNEL_ID))!;
    await saveDraft(h, { v: 2 }, new Date(NOW.getTime() + 1000));
    const after = (await h.repo.loadApplicationByApplicantAndChannel(APPLICANT, CHANNEL_ID))!;
    assert.equal(after.status, 'DRAFT');
    assert.ok(Number(after.revisionNumber) > Number(before.revisionNumber));
    assert.equal((after.qualifySnapshot as { answers: { v: number } }).answers.v, 2);
  });

  it('SUBMITTED → 拒绝（须先撤销回草稿）', async () => {
    await saveDraft(h, {});
    const row = (await h.repo.loadApplicationByApplicantAndChannel(APPLICANT, CHANNEL_ID))!;
    // 模拟提交后的编辑请求（直接置 SUBMITTED）
    await h.repo.saveApplication({ ...row, status: 'SUBMITTED' }, row.revisionNumber);

    await assert.rejects(() => saveDraft(h, {}, new Date(NOW.getTime() + 2000)), {
      code: 'REC_PRECONDITION',
      message: /已提交/,
    });
  });

  it('冒充他人保存 → REC_FORBIDDEN', async () => {
    await assert.rejects(
      () =>
        h.draft.execute({
          activityId: ACTIVITY_ID,
          channelId: CHANNEL_ID,
          applicantId: APPLICANT,
          actor: 'someone-else',
          answers: {},
          now: NOW,
        }),
      { code: 'REC_FORBIDDEN' },
    );
  });
});

describe('A2 撤销提交回草稿（withdrawApplication）', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await makeHarness();
  });

  async function submitOne(): Promise<string> {
    const formPort = (h.submit as unknown as { form: StubRecruitmentForm }).form;
    formPort.seed({ id: 'sub-x', status: 'SUBMITTED', submittedBy: APPLICANT, versionNumber: 1 });
    const result = await h.submit.execute({
      activityId: ACTIVITY_ID,
      channelId: CHANNEL_ID,
      applicantId: APPLICANT,
      departmentChoices: ['dept-a'],
      formRef: { formId: 'form-1', submissionId: 'sub-x', versionNumber: 1 },
      actor: APPLICANT,
      now: NOW,
    });
    return result.applicationId;
  }

  it('SUBMITTED → WITHDRAWN（撤销后仍可编辑草稿）', async () => {
    await submitOne();
    await h.withdraw.execute({
      activityId: ACTIVITY_ID,
      channelId: CHANNEL_ID,
      applicantId: APPLICANT,
      actor: APPLICANT,
      now: new Date(NOW.getTime() + 1000),
    });
    const row = (await h.repo.loadApplicationByApplicantAndChannel(APPLICANT, CHANNEL_ID))!;
    assert.equal(row.status, 'WITHDRAWN');

    await saveDraft(h, { again: true }, new Date(NOW.getTime() + 2000));
  });

  it('已有面试安排（SCHEDULED）→ 拒绝撤销', async () => {
    const applicationId = await submitOne();
    const interview = InterviewRecord.createPending({
      id: 'iv-1',
      applicationId,
      activityId: ACTIVITY_ID,
      clubId: CLUB_ID,
      roundId: 'round-1',
      applicantId: APPLICANT,
      now: NOW,
    });
    // 推进到 SCHEDULED（未完结状态集合成员）
    const scheduled = interview.schedule(
      new DefaultInterviewRecordStateMachine(),
      'interviewer-1',
      new Date(NOW.getTime() + 86400_000),
      '线上',
      NOW,
    );
    assert.ok(scheduled, '面试排期失败');
    await h.repo.saveInterview(interview.toSnapshot(), -1);

    await assert.rejects(
      () =>
        h.withdraw.execute({
          activityId: ACTIVITY_ID,
          channelId: CHANNEL_ID,
          applicantId: APPLICANT,
          actor: APPLICANT,
          now: new Date(NOW.getTime() + 1000),
        }),
      { code: 'REC_PRECONDITION', message: /面试/ },
    );
  });
});

describe('A2 退出招新（exitRecruitment）', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await makeHarness();
  });

  async function submitOne(): Promise<string> {
    const formPort = (h.submit as unknown as { form: StubRecruitmentForm }).form;
    formPort.seed({ id: 'sub-x', status: 'SUBMITTED', submittedBy: APPLICANT, versionNumber: 1 });
    const result = await h.submit.execute({
      activityId: ACTIVITY_ID,
      channelId: CHANNEL_ID,
      applicantId: APPLICANT,
      departmentChoices: ['dept-a'],
      formRef: { formId: 'form-1', submissionId: 'sub-x', versionNumber: 1 },
      actor: APPLICANT,
      now: NOW,
    });
    return result.applicationId;
  }

  it('confirm 非 true → 422', async () => {
    await submitOne();
    await assert.rejects(
      () =>
        h.exit.execute({
          activityId: ACTIVITY_ID,
          channelId: CHANNEL_ID,
          applicantId: APPLICANT,
          confirm: false,
          actor: APPLICANT,
          now: new Date(NOW.getTime() + 1000),
        }),
      { code: 'REC_PRECONDITION', message: /二次确认/ },
    );
  });

  it('SUBMITTED → EXITED', async () => {
    await submitOne();
    await h.exit.execute({
      activityId: ACTIVITY_ID,
      channelId: CHANNEL_ID,
      applicantId: APPLICANT,
      confirm: true,
      actor: APPLICANT,
      now: new Date(NOW.getTime() + 1000),
    });
    const row = (await h.repo.loadApplicationByApplicantAndChannel(APPLICANT, CHANNEL_ID))!;
    assert.equal(row.status, 'EXITED');
  });

  it('ACCEPTED → 拒绝（走成员退出流程）', async () => {
    await submitOne();
    const row = (await h.repo.loadApplicationByApplicantAndChannel(APPLICANT, CHANNEL_ID))!;
    await h.repo.saveApplication({ ...row, status: 'ACCEPTED' }, row.revisionNumber);
    await assert.rejects(
      () =>
        h.exit.execute({
          activityId: ACTIVITY_ID,
          channelId: CHANNEL_ID,
          applicantId: APPLICANT,
          confirm: true,
          actor: APPLICANT,
          now: new Date(NOW.getTime() + 1000),
        }),
      { code: 'REC_PRECONDITION', message: /已录取/ },
    );
  });
});
