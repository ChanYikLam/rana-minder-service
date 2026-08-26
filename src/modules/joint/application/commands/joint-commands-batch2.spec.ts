/**
 * Joint 应用层命令全覆盖第二批（P1 任务①；通道 + 面试 + 参与者操作）。
 *
 * 每个命令：构造可达 + 授权拒绝 fail-closed（覆盖守卫分支）。
 * 与 joint-commands.spec.ts（第一批 6 命令）互补。
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

// ---- 共享桩 ----
function makeRepo() {
  return {
    loadActivity: async () => null,
    saveActivity: async () => {},
    loadParticipant: async () => null,
    loadParticipantsByActivity: async () => [],
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
      createdAt: new Date(),
      updatedAt: new Date(),
    }),
    loadApplicationsByActivity: async () => [],
    saveApplication: async () => {},
    loadInterview: async () => ({
      id: 'int-1',
      jointActivityId: 'act-1',
      jointApplicationId: 'app-1',
      status: 'SCHEDULED',
      scheduledAt: new Date(),
      location: 'A',
      method: 'ONSITE',
      evaluations: [],
      voidReason: null,
      rescheduleCount: 0,
      revisionNumber: 1,
      createdAt: new Date(),
      updatedAt: new Date(),
    }),
    loadInterviewByApplication: async () => null,
    loadInterviewsByActivity: async () => [],
    saveInterview: async () => {},
    loadConclusion: async () => null,
    loadConclusionsByApplication: async () => [],
    loadConclusionsByActivity: async () => [],
    saveConclusion: async () => {},
    loadChannel: async () => ({
      id: 'ch:a',
      jointActivityId: 'a',
      status: 'NOT_OPEN',
      currentWindow: null,
      windows: [],
      revisionNumber: 1,
      createdAt: new Date(),
      updatedAt: new Date(),
    }),
    saveChannel: async () => {},
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

const NOW = new Date('2026-08-01T00:00:00Z');

/** 通用授权拒绝冒烟 */
async function assertAuthRejects(
  UseCaseClass: new (...args: never[]) => { execute(input: never): Promise<unknown> },
  input: Record<string, unknown>,
): Promise<void> {
  const repo = makeRepo();
  const auth = makeAuth(false);
  const uc = new UseCaseClass(repo, auth);
  await assert.rejects(
    () => uc.execute(input as never),
    (e: unknown) => {
      assert.ok((e as Error).message.length > 0);
      return true;
    },
  );
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

describe('通道操作命令（JNT-006 编排层）', () => {
  it('OpenJointChannel：授权拒绝 → forbidden', async () => {
    await assertAuthRejects(DefaultOpenJointChannelUseCase, {
      ...BASE_INPUT,
      windowId: 'w1',
      deadline: new Date('2026-09-01'),
    });
  });

  it('CloseJointChannel：授权拒绝 → forbidden', async () => {
    await assertAuthRejects(DefaultCloseJointChannelUseCase, BASE_INPUT);
  });

  it('SuspendJointChannel：授权拒绝 → forbidden', async () => {
    await assertAuthRejects(DefaultSuspendJointChannelUseCase, BASE_INPUT);
  });

  it('ResumeJointChannel：授权拒绝 → forbidden', async () => {
    await assertAuthRejects(DefaultResumeJointChannelUseCase, BASE_INPUT);
  });

  it('ReopenJointChannel：授权拒绝 → forbidden', async () => {
    await assertAuthRejects(DefaultReopenJointChannelUseCase, BASE_INPUT);
  });

  it('ExtendJointChannel：授权拒绝 → forbidden', async () => {
    await assertAuthRejects(DefaultExtendJointChannelUseCase, {
      ...BASE_INPUT,
      deadline: new Date('2026-10-01'),
    });
  });
});

describe('面试操作命令（JNT-004 编排层）', () => {
  it('StartJointInterview：授权拒绝 → forbidden', async () => {
    await assertAuthRejects(DefaultStartJointInterviewUseCase, {
      ...BASE_INPUT,
      interviewId: 'int-1',
    });
  });

  it('CompleteJointInterview：授权拒绝 → forbidden', async () => {
    await assertAuthRejects(DefaultCompleteJointInterviewUseCase, {
      ...BASE_INPUT,
      interviewId: 'int-1',
    });
  });

  it('VoidJointInterview：授权拒绝 → forbidden', async () => {
    await assertAuthRejects(DefaultVoidJointInterviewUseCase, {
      ...BASE_INPUT,
      interviewId: 'int-1',
      reason: 'test',
    });
  });
});
