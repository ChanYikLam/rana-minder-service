/**
 * 4 参构造 UseCase 专项测试（评审 Critical：宽松签名掩盖参数错位）。
 *
 * RestoreFromReview / SendClubInvitation 构造签名为
 * (repository, [invitation], authorization, tasks)，
 * 此前统一 3 参传参导致 authorization 位被错误占据产生 TypeError 假绿。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { DefaultRestoreFromReviewUseCase } from './restore-from-review.use-case';
import { DefaultSendClubInvitationUseCase } from './send-club-invitation.use-case';
import type { JointTaskEnqueuer } from '../../infrastructure/joint-task-enqueuer';

const NOW = new Date('2026-08-01T00:00:00Z');

const CONCLUSION_SNAP = {
  id: 'conclusion:app-1:club-a',
  jointActivityId: 'act-1',
  jointApplicationId: 'app-1',
  clubId: 'club-a',
  decision: 'ADMIT' as const,
  note: null,
  inviteStatus: 'NONE' as const,
  invitationId: null,
  versions: [],
  revisionNumber: 1,
  createdAt: NOW,
  updatedAt: NOW,
};

function makeRepo(conclusionSnap?: unknown) {
  return {
    loadActivity: async () => null,
    saveActivity: async () => {},
    loadParticipant: async () => null,
    loadParticipantsByActivity: async () => [],
    saveParticipant: async () => {},
    loadApplication: async () => null,
    loadApplicationsByActivity: async () => [],
    saveApplication: async () => {},
    loadInterview: async () => null,
    loadInterviewByApplication: async () => null,
    loadInterviewsByActivity: async () => [],
    saveInterview: async () => {},
    loadConclusion: async () => conclusionSnap ?? null,
    loadConclusionsByApplication: async () => [],
    loadConclusionsByActivity: async () => [],
    saveConclusion: async () => {},
    loadChannel: async () => null,
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

const invitationStub = {
  sendInviteNotification: async () => undefined,
} as never;

const tasksStub: JointTaskEnqueuer = {
  scheduleConfirmDeadlineScan: async () => undefined,
  scheduleChannelAutoClose: async () => undefined,
} as never;

describe('RestoreFromReviewUseCase（4 参：repository, invitation, authorization, tasks）', () => {
  it('授权拒绝：deny canRestoreReview → forbidden（非 TypeError）', async () => {
    const uc = new DefaultRestoreFromReviewUseCase(
      makeRepo(CONCLUSION_SNAP),
      invitationStub,
      makeAuth(false), // 正确第 3 参位置
      tasksStub,
    );
    await assert.rejects(
      () =>
        uc.execute({
          conclusionId: 'conclusion:app-1:club-a',
          actingClubId: 'club-a',
          subjectId: 'u_admin',
          now: NOW,
        }),
      (e: unknown) => {
        const msg = (e as Error).message;
        // 必须是领域 forbidden，而非 canRestoreReview is not a function
        assert.ok(!msg.includes('not a function'), '不应出现 TypeError');
        return msg.includes('无权') || msg.includes('forbidden') || msg.includes('IFC-ERR');
      },
    );
  });

  it('结论不存在 → notFound（在授权检查前触发）', async () => {
    const uc = new DefaultRestoreFromReviewUseCase(
      makeRepo(null),
      invitationStub,
      makeAuth(true),
      tasksStub,
    );
    await assert.rejects(
      () => uc.execute({ conclusionId: 'ghost', actingClubId: 'c', subjectId: 'u', now: NOW }),
      /社团结论/,
    );
  });
});

describe('SendClubInvitationUseCase（4 参：repository, authorization, invitation, tasks）', () => {
  it('授权拒绝：deny canManageInvitation → forbidden（非 TypeError）', async () => {
    const uc = new DefaultSendClubInvitationUseCase(
      makeRepo(null),
      makeAuth(false), // 第 2 参正确位置
      invitationStub, // 第 3 参 invitation
      tasksStub, // 第 4 参 tasks
    );
    await assert.rejects(
      () =>
        uc.execute({
          conclusionId: 'conclusion:app-1:club-a',
          actingClubId: 'club-a',
          actor: 'u_admin',
          now: NOW,
        }),
      (e: unknown) => {
        const err = e as { code?: string; message?: string };
        assert.ok(!err.message?.includes('is not a function'), '不应出现 TypeError');
        // JointDomainError: code=JNT_FORBIDDEN（非 TypeError 假绿）
        return err.code === 'JNT_FORBIDDEN' || err.message?.includes('仅授权用户') === true;
      },
    );
  });
});
