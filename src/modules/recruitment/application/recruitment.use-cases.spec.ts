/**
 * recruitment 应用层主链路用例集成测试（REC-001~004 应用层；桩端口）。
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  InMemoryRecruitmentRepository,
  StubRecruitmentAuthorization,
  StubRecruitmentForm,
} from './testing/recruitment-test-support';
import { DefaultCreateRecruitmentActivityUseCase } from './commands/create-recruitment-activity.use-case';
import { DefaultPublishRecruitmentActivityUseCase } from './commands/publish-recruitment-activity.use-case';
import { DefaultOpenApplicationChannelUseCase } from './commands/open-application-channel.use-case';
import { DefaultSubmitApplicationUseCase } from './commands/submit-application.use-case';
import { DefaultRecordDepartmentDecisionUseCase } from './commands/record-department-decision.use-case';
import { DefaultListApplicationsQuery } from './queries/list-applications.query';
import { RecruitmentActivity } from '../domain/models/recruitment-activity';
import { DefaultRecruitmentActivityStateMachine } from '../domain/state-machines/recruitment-activity.state-machine';

const NOW = new Date('2026-01-01T00:00:00Z');
const CLUB_ID = 'club-1';
const ACTOR = 'manager-1';
const APPLICANT = 'applicant-1';
const FORM_ID = 'form-1';

describe('recruitment application layer (REC-001~004)', () => {
  let repo: InMemoryRecruitmentRepository;
  let auth: StubRecruitmentAuthorization;
  let form: StubRecruitmentForm;

  beforeEach(() => {
    repo = new InMemoryRecruitmentRepository();
    auth = new StubRecruitmentAuthorization();
    form = new StubRecruitmentForm();
  });

  it('创建活动需具备管理授权', async () => {
    const useCase = new DefaultCreateRecruitmentActivityUseCase(repo, auth);
    auth.manageAllowed = false;
    await assert.rejects(
      () =>
        useCase.execute({
          clubId: CLUB_ID,
          title: '秋招',
          description: null,
          actor: ACTOR,
          now: NOW,
        }),
      { code: 'REC_FORBIDDEN' },
    );
  });

  it('活动→通道→申请→部门决定的主链路（含授权/表单/唯一性/志愿校验）', async () => {
    auth.manageAllowed = true;
    auth.submitAllowed = true;

    const activityId = 'act-1';
    const create = new DefaultCreateRecruitmentActivityUseCase(repo, auth);
    await create.execute({
      clubId: CLUB_ID,
      title: '秋招',
      description: null,
      actor: ACTOR,
      now: NOW,
      id: activityId,
    });

    // 活动进行中才能开通道：先 open 活动
    const activity = RecruitmentActivity.fromSnapshot((await repo.loadActivity(activityId))!);
    assert.ok(activity.open(new DefaultRecruitmentActivityStateMachine(), NOW), '活动开放失败');
    await repo.saveActivity(activity.toSnapshot());

    const channelId = 'ch-1';
    const openChannel = new DefaultOpenApplicationChannelUseCase(repo, auth);
    const opened = await openChannel.execute({
      activityId,
      minChoices: 1,
      maxChoices: 3,
      actor: ACTOR,
      now: NOW,
      id: channelId,
    });
    assert.strictEqual(opened.channelId, channelId);

    form.seed({ id: 'sub-1', status: 'SUBMITTED', submittedBy: APPLICANT });

    const submit = new DefaultSubmitApplicationUseCase(repo, auth, form);
    const result = await submit.execute({
      activityId,
      channelId,
      applicantId: APPLICANT,
      departmentChoices: ['dept-a', 'dept-b'],
      formRef: { formId: FORM_ID, submissionId: 'sub-1', versionNumber: 1 },
      actor: APPLICANT,
      now: NOW,
    });
    assert.ok(result.applicationId);
    assert.strictEqual(result.revisionNumber, 1);

    // 同一批次重复申请冲突
    await assert.rejects(
      () =>
        submit.execute({
          activityId,
          channelId,
          applicantId: APPLICANT,
          departmentChoices: ['dept-a'],
          actor: APPLICANT,
          now: NOW,
        }),
      { code: 'REC_CONFLICT' },
    );

    // 部门决定
    const decide = new DefaultRecordDepartmentDecisionUseCase(repo, auth);
    const decision = await decide.execute({
      applicationId: result.applicationId,
      departmentId: 'dept-a',
      decision: 'ADMIT',
      decidedBy: ACTOR,
      actor: ACTOR,
      now: NOW,
    });
    assert.strictEqual(decision.status, 'ADMITTED');

    // 列表校验（负责人可查看）
    auth.manageAllowed = true;
    const listApps = new DefaultListApplicationsQuery(repo, auth);
    const apps = await listApps.execute({ activityId, actor: ACTOR });
    assert.strictEqual(apps.length, 1);
  });

  it('未授权者不可记录部门决定', async () => {
    const activityId = 'act-2';
    const appId = 'app-2';
    const channelId = 'ch-x';
    auth.manageAllowed = true;
    const create = new DefaultCreateRecruitmentActivityUseCase(repo, auth);
    await create.execute({
      clubId: CLUB_ID,
      title: 't',
      description: null,
      actor: ACTOR,
      now: NOW,
      id: activityId,
    });
    const activity = RecruitmentActivity.fromSnapshot((await repo.loadActivity(activityId))!);
    assert.ok(activity.open(new DefaultRecruitmentActivityStateMachine(), NOW), '活动开放失败');
    await repo.saveActivity(activity.toSnapshot());
    const openChannel = new DefaultOpenApplicationChannelUseCase(repo, auth);
    await openChannel.execute({ activityId, actor: ACTOR, now: NOW, id: channelId });

    auth.submitAllowed = true;
    form.seed({ id: 'sub-2', status: 'SUBMITTED', submittedBy: APPLICANT });
    const submit = new DefaultSubmitApplicationUseCase(repo, auth, form);
    const { applicationId } = await submit.execute({
      activityId,
      channelId,
      applicantId: APPLICANT,
      departmentChoices: ['dept-a'],
      formRef: { formId: FORM_ID, submissionId: 'sub-2', versionNumber: 1 },
      actor: APPLICANT,
      now: NOW,
      id: appId,
    });

    auth.manageAllowed = false;
    const decide = new DefaultRecordDepartmentDecisionUseCase(repo, auth);
    await assert.rejects(
      () =>
        decide.execute({
          applicationId,
          departmentId: 'dept-a',
          decision: 'ADMIT',
          decidedBy: ACTOR,
          actor: ACTOR,
          now: NOW,
        }),
      { code: 'REC_FORBIDDEN' },
    );
  });

  it('发布活动（DRAFT → OPEN）后即可开放报名通道', async () => {
    auth.manageAllowed = true;
    const activityId = 'act-pub';
    const create = new DefaultCreateRecruitmentActivityUseCase(repo, auth);
    await create.execute({
      clubId: CLUB_ID,
      title: '秋招',
      description: null,
      actor: ACTOR,
      now: NOW,
      id: activityId,
    });

    // 创建后为 DRAFT，此时开通道应失败
    await assert.rejects(
      () =>
        new DefaultOpenApplicationChannelUseCase(repo, auth).execute({
          activityId,
          actor: ACTOR,
          now: NOW,
        }),
      { code: 'REC_PRECONDITION' },
    );

    // 发布后进入 OPEN
    const publish = new DefaultPublishRecruitmentActivityUseCase(repo, auth);
    const published = await publish.execute({ activityId, actor: ACTOR, now: NOW });
    assert.strictEqual(published.status, 'OPEN');
    const snapshot = await repo.loadActivity(activityId);
    assert.strictEqual(snapshot?.status, 'OPEN');

    // 发布后开通道成功
    const opened = await new DefaultOpenApplicationChannelUseCase(repo, auth).execute({
      activityId,
      minChoices: 1,
      maxChoices: 3,
      actor: ACTOR,
      now: NOW,
    });
    assert.ok(opened.channelId);
  });

  it('开放报名通道校验志愿上下限', async () => {
    auth.manageAllowed = true;
    const activityId = 'act-chan';
    const create = new DefaultCreateRecruitmentActivityUseCase(repo, auth);
    await create.execute({
      clubId: CLUB_ID,
      title: '秋招',
      description: null,
      actor: ACTOR,
      now: NOW,
      id: activityId,
    });
    const activity = RecruitmentActivity.fromSnapshot((await repo.loadActivity(activityId))!);
    assert.ok(activity.open(new DefaultRecruitmentActivityStateMachine(), NOW));
    await repo.saveActivity(activity.toSnapshot());

    const openChannel = new DefaultOpenApplicationChannelUseCase(repo, auth);
    await assert.rejects(
      () =>
        openChannel.execute({ activityId, minChoices: 3, maxChoices: 1, actor: ACTOR, now: NOW }),
      { code: 'REC_VALIDATION' },
    );
    await assert.rejects(
      () =>
        openChannel.execute({ activityId, minChoices: 0, maxChoices: 3, actor: ACTOR, now: NOW }),
      { code: 'REC_VALIDATION' },
    );
  });
});
