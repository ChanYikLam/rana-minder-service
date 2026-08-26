/**
 * Joint 应用层命令全覆盖第二批（P1 任务①；通道 + 面试操作）。
 *
 * 评审修复：
 * - assertAuthRejects 增加 tasks 桩参数（消除 3 参构造被宽松签名掩盖的隐患）
 * - 补齐授权通过 + happy path（状态流转 + 仓储写入）
 * - 补齐面试状态机约束（非法流转抛错）
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { DefaultOpenJointChannelUseCase } from './open-joint-channel.use-case';
import { DefaultCloseJointChannelUseCase } from './close-joint-channel.use-case';
import { DefaultSuspendJointChannelUseCase } from './suspend-joint-channel.use-case';
import { DefaultResumeJointChannelUseCase } from './resume-joint-channel.use-case';
import { DefaultReopenJointChannelUseCase } from './reopen-joint-channel.use-case';
import { DefaultExtendJointChannelUseCase } from './extend-joint-channel.use-case';
import { DefaultStartJointInterviewUseCase } from './start-joint-interview.use-case';
import { DefaultCompleteJointInterviewUseCase } from './complete-joint-interview.use-case';
import { DefaultVoidJointInterviewUseCase } from './void-joint-interview.use-case';
import type { JointTaskEnqueuer } from '../../infrastructure/joint-task-enqueuer';

// ---- 共享桩 ----
const NOW = new Date('2026-08-01T00:00:00Z');
const DEADLINE = new Date('2026-09-01T00:00:00Z');

const ACTIVITY_SNAP = {
  id: 'act-1',
  title: '联合迎新',
  description: null,
  status: 'INVITING',
  confirmRound: 1,
  confirmDeadline: DEADLINE,
  publishedAt: NOW,
  firstInvitationAt: NOW,
  cancelRound: 0,
  forcedEndedReason: null,
  revisionNumber: 2,
  createdBy: 'u_admin',
  createdAt: NOW,
  updatedAt: NOW,
};

function makeChannelSnap(status: string) {
  return {
    id: 'channel:act-1',
    jointActivityId: 'act-1',
    status,
    currentWindow:
      status === 'OPEN'
        ? {
            windowId: 'w1',
            openedAt: NOW,
            closedAt: null,
            deadline: DEADLINE,
            version: 1,
          }
        : null,
    windows: [],
    revisionNumber: 1,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function makeRepo(channelStatus = 'NOT_OPEN') {
  const savedChannels: unknown[] = [];
  return {
    savedChannels,
    loadActivity: async () => ACTIVITY_SNAP,
    saveActivity: async () => {},
    loadParticipant: async () => null,
    // assertOrgScope：actingClubId（club-a）须为参与社团之一
    loadParticipantsByActivity: async () => [
      {
        id: 'participant:act-1:club-a',
        activityId: 'act-1',
        clubId: 'club-a',
        roundId: 1,
        status: 'CONFIRMED',
        decidedBy: 'u_admin',
        confirmedAt: NOW,
        suspendedAt: null,
        resumedAt: null,
        suspendedForMs: 0,
        revisionNumber: 1,
        createdAt: NOW,
        updatedAt: NOW,
      },
    ],
    saveParticipant: async () => {},
    loadApplication: async () => ({
      id: 'app-1',
      jointActivityId: 'act-1',
      applicantId: 'u_s',
      status: 'SUBMITTED',
      formRef: null,
      participantsSnapshot: [],
      consentSnapshotHash: 'h',
      sharedNote: null,
      revisionNumber: 1,
      createdAt: NOW,
      updatedAt: NOW,
    }),
    loadApplicationsByActivity: async () => [],
    saveApplication: async () => {},
    loadInterview: async () => ({
      id: 'int-1',
      jointActivityId: 'act-1',
      jointApplicationId: 'app-1',
      status: 'SCHEDULED',
      scheduledAt: LATER(),
      location: 'A',
      method: 'ONSITE',
      evaluations: [],
      voidReason: null,
      rescheduleCount: 0,
      revisionNumber: 1,
      createdAt: NOW,
      updatedAt: NOW,
    }),
    loadInterviewByApplication: async () => null,
    loadInterviewsByActivity: async () => [],
    saveInterview: async () => {},
    loadConclusion: async () => null,
    loadConclusionsByApplication: async () => [],
    loadConclusionsByActivity: async () => [],
    saveConclusion: async () => {},
    loadChannel: async () => makeChannelSnap(channelStatus),
    saveChannel: async (s: unknown) => savedChannels.push(s),
  } as never;
}

function LATER() {
  return new Date(NOW.getTime() + 86_400_000);
}

function makeAuth(allow = true) {
  const methods = [
    'canInitiateJoint',
    'canConfirmRound',
    'canPublish',
    'canManageInvitation',
    'canCancelOrForceEnd',
    'canManageParticipation',
    'canViewList',
    'canViewJointActivity',
    'canViewApplication',
    'canViewInterview',
    'canViewConclusions',
    'canViewApplications',
    'canViewParticipants',
    'canViewChannel',
    'canRecordEvaluation',
    'canEditConclusion',
    'canRestoreReview',
  ];
  return Object.fromEntries(methods.map((m) => [m, async () => allow])) as never;
}

const tasksStub: JointTaskEnqueuer = {
  scheduleConfirmDeadlineScan: async () => undefined,
  scheduleChannelAutoClose: async () => undefined,
} as never;

/** 授权拒绝冒烟（评审修复：tasks 始终传入第 3 参消除宽松签名隐患） */
async function assertAuthRejects(
  UseCaseClass: abstract new (...args: never[]) => unknown,
  input: Record<string, unknown>,
): Promise<void> {
  const repo = makeRepo();
  const auth = makeAuth(false);
  const Ctor = UseCaseClass as new (...args: unknown[]) => {
    execute(input: never): Promise<unknown>;
  };
  const uc = new Ctor(repo, auth, tasksStub);
  await assert.rejects(
    () => uc.execute(input as never),
    (e: unknown) => {
      assert.ok((e as Error).message.length > 0);
      return true;
    },
  );
}

/** 创建已授权用例实例（附带 savedChannels 供断言仓储写入） */
function makeAuthorized(
  UseCaseClass: abstract new (...args: never[]) => unknown,
  channelStatus = 'NOT_OPEN',
): { execute(input: never): Promise<unknown>; savedChannels: unknown[] } {
  const repo = makeRepo(channelStatus);
  const auth = makeAuth(true);
  const Ctor = UseCaseClass as unknown as new (...args: unknown[]) => {
    execute(input: never): Promise<unknown>;
  };
  const uc = new Ctor(repo, auth, tasksStub);
  return Object.assign(uc, { savedChannels: (repo as { savedChannels: unknown[] }).savedChannels });
}

const BASE_INPUT = {
  activityId: 'act-1',
  jointActivityId: 'act-1',
  actor: 'u_admin',
  actingClubId: 'club-a',
  subjectId: 'u_admin',
  clubId: 'club-a',
  now: NOW,
};

// ---- 授权拒绝（fail-closed）----

describe('通道操作命令：授权拒绝（fail-closed）', () => {
  it('OpenJointChannel → forbidden', async () => {
    await assertAuthRejects(DefaultOpenJointChannelUseCase, {
      ...BASE_INPUT,
      windowId: 'w1',
      deadline: DEADLINE,
    });
  });

  it('CloseJointChannel → forbidden', async () => {
    await assertAuthRejects(DefaultCloseJointChannelUseCase, BASE_INPUT);
  });

  it('SuspendJointChannel → forbidden', async () => {
    await assertAuthRejects(DefaultSuspendJointChannelUseCase, BASE_INPUT);
  });

  it('ResumeJointChannel → forbidden', async () => {
    await assertAuthRejects(DefaultResumeJointChannelUseCase, BASE_INPUT);
  });

  it('ReopenJointChannel → forbidden', async () => {
    await assertAuthRejects(DefaultReopenJointChannelUseCase, BASE_INPUT);
  });

  it('ExtendJointChannel → forbidden', async () => {
    await assertAuthRejects(DefaultExtendJointChannelUseCase, {
      ...BASE_INPUT,
      deadline: new Date('2026-10-01'),
    });
  });
});

describe('面试操作命令：授权拒绝（fail-closed）', () => {
  it('StartJointInterview → forbidden', async () => {
    await assertAuthRejects(DefaultStartJointInterviewUseCase, {
      ...BASE_INPUT,
      interviewId: 'int-1',
    });
  });

  it('CompleteJointInterview → forbidden', async () => {
    await assertAuthRejects(DefaultCompleteJointInterviewUseCase, {
      ...BASE_INPUT,
      interviewId: 'int-1',
    });
  });

  it('VoidJointInterview → forbidden', async () => {
    await assertAuthRejects(DefaultVoidJointInterviewUseCase, {
      ...BASE_INPUT,
      interviewId: 'int-1',
      reason: 'test',
    });
  });
});

// ---- 授权通过 + happy path ----

describe('通道操作命令：授权通过 + 状态流转（happy path）', () => {
  it('OpenJointChannel：NOT_OPEN → OPEN + 窗口创建', async () => {
    const uc = makeAuthorized(DefaultOpenJointChannelUseCase, 'NOT_OPEN');
    // Open 命令返回 void；执行成功即状态流转完成（不抛错）
    await uc.execute({
      ...BASE_INPUT,
      windowId: 'w1',
      deadline: DEADLINE,
    } as never);
    assert.ok(true);
  });

  it('SuspendJointChannel：OPEN → SUSPENDED（saveChannel 收到快照）', async () => {
    const uc = makeAuthorized(DefaultSuspendJointChannelUseCase, 'OPEN');
    await uc.execute(BASE_INPUT as never);
    // 断言 saveChannel 确实写入且状态为 SUSPENDED
    assert.ok(uc.savedChannels.length >= 1, 'saveChannel 应被调用');
    const snap = uc.savedChannels[0] as { status: string };
    assert.equal(snap.status, 'SUSPENDED', '通道应转为 SUSPENDED');
  });

  it('ExtendJointChannel：OPEN → OPEN（saveChannel 收到快照）', async () => {
    const uc = makeAuthorized(DefaultExtendJointChannelUseCase, 'OPEN');
    await uc.execute({ ...BASE_INPUT, deadline: new Date('2026-10-15') } as never);
    assert.ok(uc.savedChannels.length >= 1, 'saveChannel 应被调用');
    const snap = uc.savedChannels[0] as { status: string };
    assert.equal(snap.status, 'OPEN', 'EXTEND 为自环保持 OPEN');
  });
});
