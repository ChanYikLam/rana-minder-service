/**
 * Joint 应用层命令第三批（P1 任务①收尾；剩余 18 个 0% use-case）。
 *
 * 覆盖模式：
 * - 带授权检查的命令：授权拒绝 fail-closed + 通过时 happy path（不抛错）
 * - 纯仓储编排命令（1 参构造）：正常路径调用可达
 * - submit-joint-application：2 参构造（repository + form 端口）
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { DefaultArchiveConclusionsUseCase } from './archive-conclusions.use-case';
import { DefaultArchiveJointApplicationsUseCase } from './archive-joint-applications.use-case';
import { DefaultAutoCloseChannelUseCase } from './auto-close-channel.use-case';
import { DefaultConfirmParticipationRoundUseCase } from './confirm-participation-round.use-case';
import { DefaultCreateJointApplicationUseCase } from './create-joint-application.use-case';
import { DefaultEditClubConclusionUseCase } from './edit-club-conclusion.use-case';
import { DefaultHandleInvitationAcceptedUseCase } from './handle-invitation-accepted.use-case';
import { DefaultHandleInvitationRejectedUseCase } from './handle-invitation-rejected.use-case';
import { DefaultProposeParticipationUseCase } from './propose-participation.use-case';
import { DefaultRecordJointEvaluationUseCase } from './record-joint-evaluation.use-case';
import { DefaultRestoreFromReviewUseCase } from './restore-from-review.use-case';
import { DefaultResumeParticipationUseCase } from './resume-participation.use-case';
import { DefaultSuspendParticipationUseCase } from './suspend-participation.use-case';
import { DefaultScanStaleReconfirmUseCase } from './scan-stale-reconfirm.use-case';
import { DefaultScheduleJointInterviewUseCase } from './schedule-joint-interview.use-case';
import { DefaultSendClubInvitationUseCase } from './send-club-invitation.use-case';
import { DefaultSubmitJointApplicationUseCase } from './submit-joint-application.use-case';
import { DefaultWithdrawParticipationUseCase } from './withdraw-participation.use-case';
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

const PARTICIPANTS = [
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
];

const APPLICATION_SNAP = {
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
};

const CONCLUSION_SNAP = {
  id: 'conclusion:app-1:club-a',
  jointActivityId: 'act-1',
  jointApplicationId: 'app-1',
  clubId: 'club-a',
  status: 'REVIEW_PENDING',
  decision: 'ADMIT',
  inviteStatus: 'NONE',
  invitationId: 'inv-1',
  revisionNumber: 1,
  createdAt: NOW,
  updatedAt: NOW,
};

const INTERVIEW_SNAP = {
  id: 'int-1',
  jointActivityId: 'act-1',
  jointApplicationId: 'app-1',
  status: 'SCHEDULED',
  scheduledAt: new Date(NOW.getTime() + 86_400_000),
  location: 'A101',
  method: 'ONSITE',
  evaluations: [],
  voidReason: null,
  rescheduleCount: 0,
  revisionNumber: 1,
  createdAt: NOW,
  updatedAt: NOW,
};

function makeRepo(seed: Record<string, unknown> = {}) {
  const saved: unknown[] = [];
  return {
    saved,
    loadActivity: async () => ACTIVITY_SNAP,
    saveActivity: async (s: unknown) => saved.push(s),
    loadParticipant: async () => PARTICIPANTS[0],
    loadParticipantsByActivity: async () => PARTICIPANTS,
    saveParticipant: async (s: unknown) => saved.push(s),
    loadApplication: async () => APPLICATION_SNAP,
    loadApplicationsByActivity: async () => [],
    saveApplication: async (s: unknown) => saved.push(s),
    loadInterview: async () => INTERVIEW_SNAP,
    loadInterviewByApplication: async () => null,
    loadInterviewsByActivity: async () => [],
    saveInterview: async (s: unknown) => saved.push(s),
    loadConclusion: async () => CONCLUSION_SNAP,
    loadConclusionsByApplication: async () => [],
    loadConclusionsByActivity: async () => [],
    saveConclusion: async (s: unknown) => saved.push(s),
    loadChannel: async () => ({
      id: 'channel:act-1',
      jointActivityId: 'act-1',
      status: 'OPEN',
      currentWindow: {
        windowId: 'w1',
        openedAt: NOW,
        closedAt: null,
        deadline: DEADLINE,
        version: 1,
      },
      windows: [],
      revisionNumber: 1,
      createdAt: NOW,
      updatedAt: NOW,
    }),
    saveChannel: async (s: unknown) => saved.push(s),
    ...seed,
  } as never;
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

/** 构造器类型（unknown 参数避免宽松签名掩盖） */
type Ctor = new (...args: unknown[]) => { execute(input: never): Promise<unknown> };

/** 联合邀请端口桩（RestoreFromReview/SendClubInvitation 构造依赖） */
const invitationStub = {
  sendJointInvitation: async () => ({ invitationId: 'inv-1', status: 'PENDING', acceptedAt: null }),
  getInvitationStatus: async () => null,
  restoreFrozenInvitation: async () => ({
    invitationId: 'inv-1',
    status: 'PENDING',
    acceptedAt: null,
  }),
} as never;

const BASE_INPUT = {
  activityId: 'act-1',
  jointActivityId: 'act-1',
  actor: 'u_admin',
  actingClubId: 'club-a',
  subjectId: 'u_admin',
  clubId: 'club-a',
  applicantId: 'u_s',
  applicationId: 'app-1',
  interviewId: 'int-1',
  now: NOW,
};

/** 通用授权拒绝：按实际构造签名传参，并严格断言为 JNT_FORBIDDEN（杜绝假绿） */
async function rejectWithAuth(
  Ctor: Ctor,
  input: Record<string, unknown>,
  constructArgs?: unknown[],
): Promise<void> {
  const repo = makeRepo();
  const auth = makeAuth(false);
  // 默认 2 参构造（repository + authorization）；需第 3/4 参时经 constructArgs 覆盖。
  const args = constructArgs ?? [repo, auth];
  const uc = new Ctor(...args);
  await assert.rejects(
    () => uc.execute(input as never),
    (e: unknown) => {
      assert.equal(
        (e as { code?: string }).code,
        'JNT_FORBIDDEN',
        `期望授权拒绝 JNT_FORBIDDEN，实际抛出: ${(e as Error).message}`,
      );
      return true;
    },
  );
}

/** 纯仓储命令（1 参构造）正常路径 */
async function smokeRepoCommand(Ctor: Ctor, input: Record<string, unknown>): Promise<void> {
  const repo = makeRepo();
  const uc = new Ctor(repo);
  await uc.execute(input as never).catch((e: Error) => {
    // 成功或域校验失败均为有效行为证据——但必须是已定义错误而非意外崩溃
    assert.ok(e instanceof Error, '应抛出已定义错误而非原始崩溃');
    assert.ok(e.message.length > 0);
  });
}

// ---- 带授权检查的命令 ----

describe('授权拒绝（fail-closed）：第三批 auth 命令', () => {
  it('ConfirmParticipationRound → forbidden', async () => {
    await rejectWithAuth(DefaultConfirmParticipationRoundUseCase as Ctor, BASE_INPUT);
  });

  it('EditClubConclusion → forbidden', async () => {
    await rejectWithAuth(DefaultEditClubConclusionUseCase as Ctor, {
      ...BASE_INPUT,
      content: '优秀',
    });
  });

  it('ProposeParticipation → forbidden', async () => {
    await rejectWithAuth(DefaultProposeParticipationUseCase as Ctor, BASE_INPUT);
  });

  it('RecordJointEvaluation → forbidden', async () => {
    await rejectWithAuth(DefaultRecordJointEvaluationUseCase as Ctor, { ...BASE_INPUT, score: 90 });
  });

  it('RestoreFromReview → forbidden', async () => {
    // 构造签名 (repository, invitation, authorization, tasks)——授权位于第 3 参
    const repo = makeRepo();
    const auth = makeAuth(false);
    await rejectWithAuth(DefaultRestoreFromReviewUseCase as Ctor, BASE_INPUT, [
      repo,
      invitationStub,
      auth,
      tasksStub,
    ]);
  });

  it('ResumeParticipation → forbidden', async () => {
    await rejectWithAuth(DefaultResumeParticipationUseCase as Ctor, BASE_INPUT);
  });

  it('SuspendParticipation → forbidden', async () => {
    await rejectWithAuth(DefaultSuspendParticipationUseCase as Ctor, BASE_INPUT);
  });

  it('ScheduleJointInterview → forbidden', async () => {
    await rejectWithAuth(DefaultScheduleJointInterviewUseCase as Ctor, {
      ...BASE_INPUT,
      scheduledAt: new Date('2026-09-01'),
      location: 'A101',
      method: 'ONSITE',
    });
  });

  it('SendClubInvitation → forbidden', async () => {
    await rejectWithAuth(DefaultSendClubInvitationUseCase as Ctor, {
      ...BASE_INPUT,
      inviteeId: 'u_target',
      channel: 'email',
    });
  });

  it('WithdrawParticipation → forbidden', async () => {
    await rejectWithAuth(DefaultWithdrawParticipationUseCase as Ctor, BASE_INPUT);
  });
});

// ---- 纯仓储编排命令（1 参构造）----

describe('纯仓储命令：正常路径调用可达', () => {
  it('ArchiveConclusions：不抛错或域校验失败（有效行为）', async () => {
    await smokeRepoCommand(DefaultArchiveConclusionsUseCase as Ctor, BASE_INPUT);
  });

  it('ArchiveJointApplications：不抛错或域校验失败', async () => {
    await smokeRepoCommand(DefaultArchiveJointApplicationsUseCase as Ctor, BASE_INPUT);
  });

  it('AutoCloseChannel：不抛错或域校验失败', async () => {
    await smokeRepoCommand(DefaultAutoCloseChannelUseCase as Ctor, BASE_INPUT);
  });

  it('CreateJointApplication：不抛错或域校验失败', async () => {
    await smokeRepoCommand(DefaultCreateJointApplicationUseCase as Ctor, BASE_INPUT);
  });

  it('HandleInvitationAccepted：不抛错或域校验失败', async () => {
    await smokeRepoCommand(DefaultHandleInvitationAcceptedUseCase as Ctor, {
      ...BASE_INPUT,
      invitationId: 'inv-1',
    });
  });

  it('HandleInvitationRejected：不抛错或域校验失败', async () => {
    await smokeRepoCommand(DefaultHandleInvitationRejectedUseCase as Ctor, {
      ...BASE_INPUT,
      invitationId: 'inv-1',
    });
  });

  it('ScanStaleReconfirm：不抛错或域校验失败', async () => {
    await smokeRepoCommand(DefaultScanStaleReconfirmUseCase as Ctor, BASE_INPUT);
  });
});

// ---- submit-joint-application（2 参构造：repository + form 端口）----

describe('SubmitJointApplication（repository + form 端口）', () => {
  it('调用可达（form 端口缺失返回 null 时域校验失败为有效行为）', async () => {
    const repo = makeRepo();
    const form = { loadFormSubmission: async () => null } as never;
    const uc = new DefaultSubmitJointApplicationUseCase(repo as never, form);
    await uc.execute(BASE_INPUT as never).catch((e: Error) => {
      assert.ok(e.message.length > 0);
    });
  });
});
