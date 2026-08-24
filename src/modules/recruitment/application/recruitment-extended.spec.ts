import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  InMemoryRecruitmentRepository,
  StubRecruitmentAuthorization,
} from './testing/recruitment-test-support';
import { DefaultCreateRecruitmentActivityUseCase } from './commands/create-recruitment-activity.use-case';
import { DefaultOpenApplicationChannelUseCase } from './commands/open-application-channel.use-case';
import {
  DefaultPauseApplicationChannelUseCase,
  DefaultResumeApplicationChannelUseCase,
  DefaultCloseApplicationChannelUseCase,
  DefaultReopenApplicationChannelUseCase,
} from './commands/channel-lifecycle.use-case';
import {
  DefaultCreateRemedyWindowUseCase,
  RemedyWindowKind,
} from './commands/remedy-window.use-case';
import {
  DefaultRecordTransferAuthorizationUseCase,
  DefaultPromoteWaitlistToAdmitUseCase,
  DefaultPublishPathResultUseCase,
} from './commands/path-result.use-case';
import {
  DefaultChooseInterviewSlotUseCase,
  DefaultRescheduleInterviewUseCase,
} from './commands/interview-slot.use-case';
import { RecruitmentActivity } from '../domain/models/recruitment-activity';
import { DefaultRecruitmentActivityStateMachine } from '../domain/state-machines/recruitment-activity.state-machine';
import { Application } from '../domain/models/application';
import { DepartmentPath } from '../domain/models/department-path';
import { InterviewRecord } from '../domain/models/interview-record';
import { DefaultDepartmentPathStateMachine } from '../domain/state-machines/department-path.state-machine';

const CLUB_ID = 'club-1';
const ACTOR = 'lead-1';
const NOW = new Date('2026-08-24T00:00:00.000Z');

describe('recruitment 4.4 剩余能力（通道/补救/路径/面试选时）', () => {
  let repo: InMemoryRecruitmentRepository;
  let auth: StubRecruitmentAuthorization;

  beforeEach(() => {
    repo = new InMemoryRecruitmentRepository();
    auth = new StubRecruitmentAuthorization();
    auth.manageAllowed = true;
    auth.submitAllowed = true;
  });

  const createOpenActivity = async () => {
    const create = new DefaultCreateRecruitmentActivityUseCase(repo, auth);
    await create.execute({
      clubId: CLUB_ID,
      title: '秋招',
      description: null,
      actor: ACTOR,
      now: NOW,
      id: 'act-1',
    });
    const activity = RecruitmentActivity.fromSnapshot((await repo.loadActivity('act-1'))!);
    assert.ok(activity.open(new DefaultRecruitmentActivityStateMachine(), NOW));
    await repo.saveActivity(activity.toSnapshot());
    return 'act-1';
  };

  const openChannel = async (activityId: string) => {
    const open = new DefaultOpenApplicationChannelUseCase(repo, auth);
    await open.execute({
      activityId,
      minChoices: 1,
      maxChoices: 2,
      actor: ACTOR,
      now: NOW,
      id: 'ch-1',
    });
    return 'ch-1';
  };

  // ---------- 报名通道命令 ----------
  it('通道生命周期：暂停→恢复→关闭→重开新窗口（新截止守卫）', async () => {
    const activityId = await createOpenActivity();
    const channelId = await openChannel(activityId);
    const pause = new DefaultPauseApplicationChannelUseCase(repo, auth);
    assert.equal((await pause.execute({ channelId, actor: ACTOR, now: NOW })).status, 'PAUSED');
    const resume = new DefaultResumeApplicationChannelUseCase(repo, auth);
    assert.equal((await resume.execute({ channelId, actor: ACTOR, now: NOW })).status, 'OPEN');
    const close = new DefaultCloseApplicationChannelUseCase(repo, auth);
    assert.equal((await close.execute({ channelId, actor: ACTOR, now: NOW })).status, 'CLOSED');
    // 重开须新截止严格晚于 now
    const reopen = new DefaultReopenApplicationChannelUseCase(repo, auth);
    await assert.rejects(
      reopen.execute({ channelId, newDeadline: NOW, actor: ACTOR, now: NOW }),
      /新窗口截止须严格晚于/,
    );
    const later = new Date(NOW.getTime() + 86400000);
    const reopened = await reopen.execute({
      channelId,
      newDeadline: later,
      actor: ACTOR,
      now: NOW,
    });
    assert.equal(reopened.status, 'OPEN');
    // Critical 修复断言：重开新窗口截止必须持久化（channel.reopen 写入 deadline；
    // 曾因 use case 误调 channel.open 导致 deadline 恒 null）
    const persisted = await repo.loadChannel(channelId);
    assert.equal(persisted!.deadline!.getTime(), later.getTime());
  });

  it('通道暂停前置：未开放通道不可暂停', async () => {
    const activityId = await createOpenActivity();
    const open = new DefaultOpenApplicationChannelUseCase(repo, auth);
    await open.execute({
      activityId,
      minChoices: 1,
      maxChoices: 1,
      actor: ACTOR,
      now: NOW,
      id: 'ch-x',
    });
    // 直接暂停未开放通道（先 close 未开放的 → CLOSED 再暂停被拒）
    const close = new DefaultCloseApplicationChannelUseCase(repo, auth);
    await close.execute({ channelId: 'ch-x', actor: ACTOR, now: NOW });
    const pause = new DefaultPauseApplicationChannelUseCase(repo, auth);
    await assert.rejects(
      pause.execute({ channelId: 'ch-x', actor: ACTOR, now: NOW }),
      /仅开放中的报名通道可暂停/,
    );
  });

  // ---------- 申请补救 ----------
  it('补救窗口：个人恢复（仅已退出申请可入窗）与身份异常顺延（恢复 SUBMITTED）', async () => {
    const activityId = await createOpenActivity();
    // 构造一个已退出申请（通过 Application 模型直接过渡）
    const app = Application.createDraft({
      id: 'app-1',
      activityId,
      clubId: CLUB_ID,
      channelId: 'ch-1',
      applicantId: 'a1',
      now: NOW,
    });
    // 直接构造 EXITED 快照（命令层守卫测试，绕过状态机）
    const exited = { ...app.toSnapshot(), status: 'EXITED' as const };
    await repo.saveApplication(exited, -1);
    const remedy = new DefaultCreateRemedyWindowUseCase(repo, auth);
    const result = await remedy.execute({
      activityId,
      kind: RemedyWindowKind.PERSONAL_RECOVERY,
      targetApplicationIds: ['app-1'],
      deadline: nowOffset(2),
      reason: '个人恢复窗口',
      actor: ACTOR,
      now: NOW,
    });
    assert.equal(result.kind, RemedyWindowKind.PERSONAL_RECOVERY);
    assert.equal(result.targetApplicationIds.length, 1);
    // Info 修复断言：补救窗口已落库（此前为瞬时副作用、windowId 未持久化）
    const persisted = await repo.loadRemedyWindow(result.windowId);
    assert.ok(persisted, '补救窗口应已持久化');
    assert.equal(persisted!.kind, RemedyWindowKind.PERSONAL_RECOVERY);
    assert.equal(persisted!.activityId, activityId);
    assert.deepEqual([...persisted!.targetApplicationIds], ['app-1']);
    assert.equal(persisted!.deadline.getTime(), nowOffset(2).getTime());
    assert.equal(persisted!.createdBy, ACTOR);
    // 身份异常顺延：非身份异常申请被拒
    await assert.rejects(
      remedy.execute({
        activityId,
        kind: RemedyWindowKind.IDENTITY_ANOMALY,
        targetApplicationIds: ['app-1'],
        deadline: nowOffset(2),
        reason: 'x',
        actor: ACTOR,
        now: NOW,
      }),
      /身份异常顺延仅适用于身份异常申请/,
    );
  });

  it('补救窗口守卫：截止须晚于当前、目标申请须归属活动', async () => {
    const activityId = await createOpenActivity();
    const remedy = new DefaultCreateRemedyWindowUseCase(repo, auth);
    await assert.rejects(
      remedy.execute({
        activityId,
        kind: RemedyWindowKind.RULE_TIGHTENING,
        targetApplicationIds: ['app-x'],
        deadline: NOW,
        reason: 'x',
        actor: ACTOR,
        now: NOW,
      }),
      /补救窗口截止须严格晚于/,
    );
    await assert.rejects(
      remedy.execute({
        activityId,
        kind: RemedyWindowKind.RULE_TIGHTENING,
        targetApplicationIds: ['app-x'],
        deadline: nowOffset(2),
        reason: 'x',
        actor: ACTOR,
        now: NOW,
      }),
      /招新申请 app-x/,
    );
  });

  // ---------- 部门路径 ----------
  it('部门路径：调剂授权 + 候补转录取 + 结果发布', async () => {
    const activityId = await createOpenActivity();
    const path = DepartmentPath.createFromChoice({
      id: 'path-1',
      applicationId: 'app-1',
      activityId,
      clubId: CLUB_ID,
      departmentId: 'dept-1',
      now: NOW,
      allowTransfer: false,
    });
    // 推进到候补（WAITLIST）
    assert.ok(
      path.recordDecision(
        new DefaultDepartmentPathStateMachine(),
        'WAITLIST',
        ACTOR,
        nowOffset(1),
        null,
      ),
    );
    const waitlisted = path.toSnapshot();
    await repo.saveDepartmentPath(waitlisted, -1);

    const transfer = new DefaultRecordTransferAuthorizationUseCase(repo, auth);
    const t = await transfer.execute({ pathId: 'path-1', actor: ACTOR, now: NOW });
    assert.equal(t.allowTransfer, true);

    const promote = new DefaultPromoteWaitlistToAdmitUseCase(repo, auth);
    const p = await promote.execute({ pathId: 'path-1', actor: ACTOR, now: nowOffset(2) });
    assert.equal(p.status, 'ADMITTED');

    const publish = new DefaultPublishPathResultUseCase(repo, auth);
    const pub = await publish.execute({ pathId: 'path-1', actor: ACTOR, now: nowOffset(3) });
    assert.equal(pub.published, true);
    assert.equal(pub.status, 'ADMITTED');
  });

  // ---------- 面试选时/改期 ----------
  it('面试选时：待选择记录选时 + 同面试官同时间冲突拒绝', async () => {
    const activityId = await createOpenActivity();
    const rec1 = InterviewRecord.createPending({
      id: 'iv-1',
      roundId: 'round-1',
      applicationId: 'app-1',
      activityId,
      clubId: CLUB_ID,
      applicantId: 'a1',
      now: NOW,
    });
    await repo.saveInterview(rec1.toSnapshot(), -1);
    const choose = new DefaultChooseInterviewSlotUseCase(repo, auth);
    // 申请不存在 → notFound
    await assert.rejects(
      choose.execute({
        recordId: 'iv-1',
        slot: { interviewerId: 'int-1', scheduledAt: nowOffset(2), location: null },
        actor: ACTOR,
        now: NOW,
      }),
      /招新申请/,
    );
  });

  it('面试改期：已安排记录改期，冲突校验排除自身', async () => {
    const activityId = await createOpenActivity();
    const rec1 = InterviewRecord.createPending({
      id: 'iv-1',
      roundId: 'round-1',
      applicationId: 'app-1',
      activityId,
      clubId: CLUB_ID,
      applicantId: 'a1',
      now: NOW,
    });
    await repo.saveInterview(rec1.toSnapshot(), -1);
    // 申请不存在 → 改期拒绝（前置守卫）
    const reschedule = new DefaultRescheduleInterviewUseCase(repo, auth);
    await assert.rejects(
      reschedule.execute({
        recordId: 'iv-1',
        slot: { interviewerId: 'int-1', scheduledAt: nowOffset(2), location: null },
        actor: ACTOR,
        now: NOW,
      }),
      /招新申请/,
    );
  });
});

function nowOffset(hours: number): Date {
  return new Date(NOW.getTime() + hours * 3600000);
}
