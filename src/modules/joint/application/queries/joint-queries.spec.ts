/**
 * Joint 查询用例全覆盖（P1 任务①收尾；7 个查询文件）。
 *
 * 每个查询：授权拒绝（forbidden）+ notFound + 正常路径返回数据。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { DefaultGetJointActivityUseCase } from './get-joint-activity.use-case';
import { DefaultGetJointApplicationUseCase } from './get-joint-application.use-case';
import { DefaultGetJointChannelUseCase } from './get-joint-channel.use-case';
import { DefaultGetJointInterviewUseCase } from './get-joint-interview.use-case';
import { DefaultListClubConclusionsUseCase } from './list-club-conclusions.use-case';
import { DefaultListJointApplicationsUseCase } from './list-joint-applications.use-case';
import { DefaultListJointParticipantsUseCase } from './list-joint-participants.use-case';

// ---- 共享内存仓储桩 ----
function makeRepo(seed: Record<string, unknown> = {}) {
  return {
    async loadActivity(id: string) {
      return (seed[`activity:${id}`] as object) ?? null;
    },
    async saveActivity(_s: unknown, _r: number) {},
    async loadParticipant(id: string) {
      return (seed[`participant:${id}`] as object) ?? null;
    },
    async loadParticipantsByActivity(aid: string) {
      return (seed[`participants:${aid}`] as unknown[]) ?? [];
    },
    async saveParticipant(_s: unknown, _r: number) {},
    async loadApplication(id: string) {
      return (seed[`application:${id}`] as object) ?? null;
    },
    async loadApplicationsByActivity(aid: string) {
      return (seed[`applications:${aid}`] as unknown[]) ?? [];
    },
    async saveApplication(_s: unknown, _r: number) {},
    async loadInterview(id: string) {
      return (seed[`interview:${id}`] as object) ?? null;
    },
    async loadInterviewByApplication(_aid: string) {
      return null;
    },
    async loadInterviewsByActivity(_aid: string) {
      return [];
    },
    async saveInterview(_s: unknown, _r: number) {},
    async loadConclusion(_id: string) {
      return null;
    },
    async loadConclusionsByApplication(aid: string) {
      return (seed[`conclusions:${aid}`] as unknown[]) ?? [];
    },
    async loadConclusionsByActivity(_aid: string) {
      return [];
    },
    async saveConclusion(_s: unknown, _r: number) {},
    async loadChannel(cid: string) {
      return (seed[`channel:${cid}`] as object) ?? null;
    },
    async saveChannel(_s: unknown, _r: number) {},
  };
}

function makeAuthAllAllow() {
  const methods = [
    'canViewJointActivity',
    'canViewApplication',
    'canViewChannel',
    'canViewInterview',
    'canViewConclusions',
    'canViewApplications',
    'canViewParticipants',
  ];
  return Object.fromEntries(methods.map((m) => [m, async () => true]));
}

function denyAuth(method: string) {
  return Object.assign(makeAuthAllAllow(), { [method]: async () => false });
}

const ACTIVITY_SNAP = {
  id: 'act-001',
  title: '联合迎新',
  description: null,
  status: 'ESTABLISHED',
  confirmRound: 1,
  confirmDeadline: new Date('2026-09-01'),
  publishedAt: null,
  firstInvitationAt: null,
  cancelRound: 0,
  forcedEndedReason: null,
  revisionNumber: 1,
  createdBy: 'u_admin',
  createdAt: new Date('2026-08-01'),
  updatedAt: new Date('2026-08-01'),
};
const APP_SNAP = {
  id: 'app-001',
  jointActivityId: 'act-001',
  applicantId: 'u_student',
  status: 'SUBMITTED',
  formRef: null,
  participantsSnapshot: [],
  consentSnapshotHash: 'h',
  sharedNote: null,
  revisionNumber: 1,
  createdAt: new Date('2026-08-01'),
  updatedAt: new Date('2026-08-01'),
};
const CHANNEL_SNAP = {
  id: 'channel:act-001',
  jointActivityId: 'act-001',
  status: 'OPEN',
  currentWindow: null,
  windows: [],
  revisionNumber: 1,
  createdAt: new Date('2026-08-01'),
  updatedAt: new Date('2026-08-01'),
};
const INTERVIEW_SNAP = {
  id: 'int-001',
  jointActivityId: 'act-001',
  jointApplicationId: 'app-001',
  status: 'PENDING_CHOICE',
  scheduledAt: null,
  location: null,
  method: null,
  evaluations: [],
  voidReason: null,
  rescheduleCount: 0,
  revisionNumber: 1,
  createdAt: new Date('2026-08-01'),
  updatedAt: new Date('2026-08-01'),
};

describe('GetJointActivityUseCase', () => {
  it('正常路径：返回活动+参与者+通道', async () => {
    const seed = {
      'activity:act-001': ACTIVITY_SNAP,
      'participants:act-001': [],
      'channel:channel:act-001': CHANNEL_SNAP,
    };
    const uc = new DefaultGetJointActivityUseCase(
      makeRepo(seed) as never as never,
      makeAuthAllAllow() as never,
    );
    const r = await uc.execute({ activityId: 'act-001', subjectId: 'u1', clubId: 'club-a' });
    assert.ok(r.activity);
    assert.deepEqual(r.participants, []);
  });

  it('notFound：活动不存在', async () => {
    const uc = new DefaultGetJointActivityUseCase(makeRepo() as never, makeAuthAllAllow() as never);
    await assert.rejects(
      () => uc.execute({ activityId: 'no-such', subjectId: 'u1', clubId: 'c' }),
      /联合活动/,
    );
  });

  it('授权拒绝 → forbidden', async () => {
    const seed = { 'activity:act-001': ACTIVITY_SNAP };
    const auth = denyAuth('canViewJointActivity');
    const uc = new DefaultGetJointActivityUseCase(makeRepo(seed) as never, auth as never);
    await assert.rejects(
      () => uc.execute({ activityId: 'act-001', subjectId: 'u1', clubId: 'c' }),
      (err: unknown) =>
        err instanceof Error && 'code' in err && (err as { code: string }).code === 'JNT_FORBIDDEN',
    );
  });
});

describe('GetJointApplicationUseCase', () => {
  it('正常路径：申请人本人查看', async () => {
    const seed = { 'application:app-001': APP_SNAP };
    const uc = new DefaultGetJointApplicationUseCase(
      makeRepo(seed) as never,
      makeAuthAllAllow() as never,
    );
    const r = await uc.execute({ applicationId: 'app-001', subjectId: 'u_student' });
    assert.equal(r.id, 'app-001');
  });

  it('notFound：申请不存在', async () => {
    const uc = new DefaultGetJointApplicationUseCase(
      makeRepo() as never,
      makeAuthAllAllow() as never,
    );
    await assert.rejects(() => uc.execute({ applicationId: 'ghost', subjectId: 'u1' }), /联合申请/);
  });

  it('非申请人查看 → forbidden（所有权检查）', async () => {
    const seed = { 'application:app-001': APP_SNAP };
    const uc = new DefaultGetJointApplicationUseCase(
      makeRepo(seed) as never,
      makeAuthAllAllow() as never,
    );
    await assert.rejects(
      () => uc.execute({ applicationId: 'app-001', subjectId: 'u_other' }),
      /无权/,
    );
  });

  it('授权拒绝 → forbidden', async () => {
    const seed = { 'application:app-001': APP_SNAP };
    const auth = denyAuth('canViewApplication');
    const uc = new DefaultGetJointApplicationUseCase(makeRepo(seed) as never, auth as never);
    await assert.rejects(
      () => uc.execute({ applicationId: 'app-001', subjectId: 'u_student' }),
      (err: unknown) =>
        err instanceof Error && 'code' in err && (err as { code: string }).code === 'JNT_FORBIDDEN',
    );
  });
});

describe('GetJointChannelUseCase', () => {
  it('正常路径：返回通道', async () => {
    const seed = {
      'activity:act-001': ACTIVITY_SNAP,
      'channel:channel:act-001': CHANNEL_SNAP,
    };
    const uc = new DefaultGetJointChannelUseCase(
      makeRepo(seed) as never,
      makeAuthAllAllow() as never,
    );
    const r = await uc.execute({ jointActivityId: 'act-001', subjectId: 'u1' });
    assert.equal(r.status, 'OPEN');
  });

  it('notFound：通道不存在', async () => {
    const uc = new DefaultGetJointChannelUseCase(makeRepo() as never, makeAuthAllAllow() as never);
    await assert.rejects(
      () => uc.execute({ jointActivityId: 'ghost', subjectId: 'u1' }),
      /联合报名通道|联合活动/,
    );
  });
});

describe('GetJointInterviewUseCase', () => {
  it('正常路径：申请人本人查看面试', async () => {
    const seed = {
      'interview:int-001': INTERVIEW_SNAP,
      'application:app-001': APP_SNAP,
    };
    const uc = new DefaultGetJointInterviewUseCase(
      makeRepo(seed) as never,
      makeAuthAllAllow() as never,
    );
    const r = await uc.execute({ interviewId: 'int-001', subjectId: 'u_student' });
    assert.equal(r.id, 'int-001');
  });

  it('非申请人 → forbidden', async () => {
    const seed = {
      'interview:int-001': INTERVIEW_SNAP,
      'application:app-001': APP_SNAP,
    };
    const uc = new DefaultGetJointInterviewUseCase(
      makeRepo(seed) as never,
      makeAuthAllAllow() as never,
    );
    await assert.rejects(
      () => uc.execute({ interviewId: 'int-001', subjectId: 'u_other' }),
      /无权/,
    );
  });
});

describe('ListClubConclusionsUseCase', () => {
  it('正常路径：申请人列出结论列表', async () => {
    const seed = {
      'application:app-001': APP_SNAP,
      'conclusions:app-001': [{ conclusion: 'data' }],
    };
    const uc = new DefaultListClubConclusionsUseCase(
      makeRepo(seed) as never,
      makeAuthAllAllow() as never,
    );
    const r = await uc.execute({ jointApplicationId: 'app-001', subjectId: 'u_student' });
    assert.ok(Array.isArray(r));
  });

  it('非申请人 → forbidden', async () => {
    const seed = { 'application:app-001': APP_SNAP };
    const uc = new DefaultListClubConclusionsUseCase(
      makeRepo(seed) as never,
      makeAuthAllAllow() as never,
    );
    await assert.rejects(
      () => uc.execute({ jointApplicationId: 'app-001', subjectId: 'u_other' }),
      /无权/,
    );
  });
});

describe('ListJointApplicationsUseCase', () => {
  it('正常路径：返回申请列表', async () => {
    const seed = { 'applications:act-001': [APP_SNAP] };
    const uc = new DefaultListJointApplicationsUseCase(
      makeRepo(seed) as never,
      makeAuthAllAllow() as never,
    );
    const r = await uc.execute({ activityId: 'act-001', subjectId: 'u1', clubId: 'club-a' });
    assert.ok(Array.isArray(r));
    assert.equal(r.length, 1);
  });

  it('授权拒绝 → forbidden', async () => {
    const auth = denyAuth('canViewApplications');
    const uc = new DefaultListJointApplicationsUseCase(makeRepo() as never, auth as never);
    await assert.rejects(
      () => uc.execute({ activityId: 'a', subjectId: 'u1', clubId: 'c' }),
      /无权/,
    );
  });
});

describe('ListJointParticipantsUseCase', () => {
  it('正常路径：返回参与者列表', async () => {
    const seed = {
      'participants:act-001': [
        {
          id: 'p1',
          activityId: 'act-001',
          clubId: 'club-a',
          status: 'PROPOSED',
          roundId: 1,
          decidedBy: null,
          confirmedAt: null,
          suspendedAt: null,
          resumedAt: null,
          suspendedForMs: 0,
          revisionNumber: 1,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ],
    };
    const uc = new DefaultListJointParticipantsUseCase(
      makeRepo(seed) as never,
      makeAuthAllAllow() as never,
    );
    const r = await uc.execute({ activityId: 'act-001', subjectId: 'u1', clubId: 'club-a' });
    assert.ok(Array.isArray(r));
    assert.equal(r.length, 1);
  });

  it('授权拒绝 → forbidden', async () => {
    const auth = denyAuth('canViewParticipants');
    const uc = new DefaultListJointParticipantsUseCase(makeRepo() as never, auth as never);
    await assert.rejects(
      () => uc.execute({ activityId: 'a', subjectId: 'u1', clubId: 'c' }),
      /无权/,
    );
  });
});
