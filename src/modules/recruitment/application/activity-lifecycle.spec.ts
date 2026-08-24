import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  InMemoryRecruitmentRepository,
  StubRecruitmentAuthorization,
} from './testing/recruitment-test-support';
import { DefaultCreateRecruitmentActivityUseCase } from './commands/create-recruitment-activity.use-case';
import {
  DefaultPauseRecruitmentActivityUseCase,
  DefaultResumeRecruitmentActivityUseCase,
  DefaultCompleteRecruitmentActivityUseCase,
  DefaultCancelRecruitmentActivityUseCase,
  DefaultForceCompleteRecruitmentActivityUseCase,
} from './commands/activity-lifecycle.use-case';
import { RecruitmentActivity } from '../domain/models/recruitment-activity';
import { DefaultRecruitmentActivityStateMachine } from '../domain/state-machines/recruitment-activity.state-machine';

const CLUB_ID = 'club-1';
const ACTOR = 'lead-1';
const NOW = new Date('2026-08-24T00:00:00.000Z');

describe('recruitment activity lifecycle（REC-001 补充 use-case）', () => {
  let repo: InMemoryRecruitmentRepository;
  let auth: StubRecruitmentAuthorization;

  beforeEach(() => {
    repo = new InMemoryRecruitmentRepository();
    auth = new StubRecruitmentAuthorization();
  });

  const createOpenActivity = async () => {
    auth.manageAllowed = true;
    const create = new DefaultCreateRecruitmentActivityUseCase(repo, auth);
    const id = 'act-1';
    await create.execute({
      clubId: CLUB_ID,
      title: '秋招',
      description: null,
      actor: ACTOR,
      now: NOW,
      id,
    });
    // 打开活动（DRAFT → OPEN）
    const activity = RecruitmentActivity.fromSnapshot((await repo.loadActivity(id))!);
    assert.ok(activity.open(new DefaultRecruitmentActivityStateMachine(), NOW));
    await repo.saveActivity(activity.toSnapshot());
    return id;
  };

  it('暂停→恢复：仅进行中可暂停；暂停标志冻结；恢复解除（成功路径）', async () => {
    const id = await createOpenActivity();
    const pause = new DefaultPauseRecruitmentActivityUseCase(repo, auth);
    const paused = await pause.execute({ activityId: id, actor: ACTOR, now: NOW });
    assert.equal(paused.status, 'OPEN');
    assert.equal(paused.paused, true);
    const resume = new DefaultResumeRecruitmentActivityUseCase(repo, auth);
    const resumed = await resume.execute({ activityId: id, actor: ACTOR, now: NOW });
    assert.equal(resumed.paused, false);
  });

  it('暂停授权拒绝：非管理权限 → forbidden', async () => {
    const id = await createOpenActivity();
    auth.manageAllowed = false;
    const pause = new DefaultPauseRecruitmentActivityUseCase(repo, auth);
    await assert.rejects(pause.execute({ activityId: id, actor: ACTOR, now: NOW }), /仅社团负责人/);
  });

  it('暂停前置：非进行中（草稿）→ preconditionFailed', async () => {
    auth.manageAllowed = true;
    const create = new DefaultCreateRecruitmentActivityUseCase(repo, auth);
    await create.execute({
      clubId: CLUB_ID,
      title: 't',
      description: null,
      actor: ACTOR,
      now: NOW,
      id: 'act-draft',
    });
    const pause = new DefaultPauseRecruitmentActivityUseCase(repo, auth);
    await assert.rejects(
      pause.execute({ activityId: 'act-draft', actor: ACTOR, now: NOW }),
      /仅进行中的招新活动可暂停/,
    );
  });

  it('完成：OPEN → COMPLETED（状态机转换）', async () => {
    const id = await createOpenActivity();
    const complete = new DefaultCompleteRecruitmentActivityUseCase(repo, auth);
    const result = await complete.execute({ activityId: id, actor: ACTOR, now: NOW });
    assert.equal(result.status, 'COMPLETED');
    // 终态只读：再次完成被拒
    await assert.rejects(
      complete.execute({ activityId: id, actor: ACTOR, now: NOW }),
      /当前状态不允许/,
    );
  });

  it('取消：OPEN → CANCELLED（状态机转换）', async () => {
    const id = await createOpenActivity();
    const cancel = new DefaultCancelRecruitmentActivityUseCase(repo, auth);
    const result = await cancel.execute({ activityId: id, actor: ACTOR, now: NOW });
    assert.equal(result.status, 'CANCELLED');
  });

  it('取消：DRAFT → CANCELLED（草稿可取消）', async () => {
    auth.manageAllowed = true;
    const create = new DefaultCreateRecruitmentActivityUseCase(repo, auth);
    await create.execute({
      clubId: CLUB_ID,
      title: 't',
      description: null,
      actor: ACTOR,
      now: NOW,
      id: 'act-d',
    });
    const cancel = new DefaultCancelRecruitmentActivityUseCase(repo, auth);
    const result = await cancel.execute({ activityId: 'act-d', actor: ACTOR, now: NOW });
    assert.equal(result.status, 'CANCELLED');
  });

  it('超管强制完成：暂停中的进行中活动直接 COMPLETED（跳过状态机）', async () => {
    const id = await createOpenActivity();
    // 先暂停
    const pause = new DefaultPauseRecruitmentActivityUseCase(repo, auth);
    await pause.execute({ activityId: id, actor: ACTOR, now: NOW });
    const force = new DefaultForceCompleteRecruitmentActivityUseCase(repo, auth);
    const result = await force.execute({ activityId: id, actor: ACTOR, now: NOW });
    assert.equal(result.status, 'COMPLETED');
    assert.equal(result.paused, false); // 强制完成清除暂停标志
  });

  it('超管强制完成：草稿也可强制完成', async () => {
    auth.manageAllowed = true;
    const create = new DefaultCreateRecruitmentActivityUseCase(repo, auth);
    await create.execute({
      clubId: CLUB_ID,
      title: 't',
      description: null,
      actor: ACTOR,
      now: NOW,
      id: 'act-d',
    });
    const force = new DefaultForceCompleteRecruitmentActivityUseCase(repo, auth);
    const result = await force.execute({ activityId: 'act-d', actor: ACTOR, now: NOW });
    assert.equal(result.status, 'COMPLETED');
  });

  it('超管强制完成：终态拒绝（COMPLETED/CANCELLED 只读）', async () => {
    const id = await createOpenActivity();
    const complete = new DefaultCompleteRecruitmentActivityUseCase(repo, auth);
    await complete.execute({ activityId: id, actor: ACTOR, now: NOW });
    const force = new DefaultForceCompleteRecruitmentActivityUseCase(repo, auth);
    await assert.rejects(force.execute({ activityId: id, actor: ACTOR, now: NOW }), /已处于终态/);
  });
});
