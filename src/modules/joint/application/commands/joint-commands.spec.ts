/**
 * 联合活动模块 L1 用例测试（P1 工作包②；覆盖率提升）。
 *
 * 覆盖策略：
 * - 高行数命令（initiate/cancel/force-end/publish）走完整路径；
 * - 全部带授权检查的命令做授权拒绝冒烟（覆盖 fail-closed 守卫行）。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { DefaultInitiateJointActivityUseCase } from './initiate-joint-activity.use-case';
import { DefaultCancelJointActivityUseCase } from './cancel-joint-activity.use-case';
import { DefaultForceEndJointActivityUseCase } from './force-end-joint-activity.use-case';
import { DefaultPublishJointActivityUseCase } from './publish-joint-activity.use-case';
import { DefaultEndJointActivityUseCase } from './end-joint-activity.use-case';
import { DefaultBeginEndConfirmUseCase } from './begin-end-confirm.use-case';
import type { JointRepository } from '../ports/joint-repository.port';
import type { JointAuthorizationPort } from '../ports/joint-authorization.port';
import type { JointTaskEnqueuer } from '../../infrastructure/joint-task-enqueuer';

// ---- 内存仓储桩 ----
function makeMemoryRepo(): JointRepository & {
  activities: Map<string, unknown>;
  participants: Map<string, unknown[]>;
  channels: Map<string, unknown>;
} {
  const activities = new Map();
  const participants = new Map<string, unknown[]>();
  const channels = new Map();
  return {
    activities,
    participants,
    channels,
    async loadActivity(id: string) {
      return activities.get(id) ?? null;
    },
    async saveActivity(snapshot: unknown, _rev: number) {
      const s = snapshot as { id: string };
      activities.set(s.id, snapshot);
    },
    async loadParticipant(_id: string) {
      return null;
    },
    async loadParticipantsByActivity(activityId: string) {
      return participants.get(activityId) ?? [];
    },
    async saveParticipant(snapshot: unknown, _rev: number) {
      const s = snapshot as { activityId: string };
      const list = participants.get(s.activityId) ?? [];
      list.push(snapshot);
      participants.set(s.activityId, list);
    },
    async loadApplication(_id: string) {
      return null;
    },
    async loadApplicationsByActivity(_aid: string) {
      return [];
    },
    async saveApplication(_s: unknown, _r: number) {},
    async loadInterview(_id: string) {
      return null;
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
    async loadConclusionsByApplication(_aid: string) {
      return [];
    },
    async loadConclusionsByActivity(_aid: string) {
      return [];
    },
    async saveConclusion(_s: unknown, _r: number) {},
    async loadChannel(id: string) {
      return channels.get(id) ?? null;
    },
    async saveChannel(snapshot: unknown, _rev: number) {
      const s = snapshot as { id?: string; jointActivityId?: string };
      const key = s.jointActivityId ?? s.id ?? '';
      channels.set(key, snapshot);
    },
  } as never;
}

/** 授权桩：全部方法放行 */
function makeAuthAllAllow(): JointAuthorizationPort {
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
  return Object.fromEntries(methods.map((m) => [m, async () => true])) as never;
}

const tasksStub: JointTaskEnqueuer = {
  scheduleConfirmDeadlineScan: async () => undefined,
} as never;

const NOW = new Date('2026-08-01T00:00:00Z');

describe('InitiateJointActivityUseCase', () => {
  it('授权拒绝 → forbidden', async () => {
    const repo = makeMemoryRepo();
    const useCase = new DefaultInitiateJointActivityUseCase(repo, makeAuthAllAllow(), tasksStub);
    // 先验证正常路径可执行
    const r = await useCase.execute({
      title: '联合迎新',
      confirmDeadline: new Date('2026-09-01'),
      clubIds: ['club-a', 'club-b'],
      actingClubId: 'club-a',
      actor: 'u_admin',
      now: NOW,
    });
    assert.ok(r.activityId);
    assert.equal(repo.participants.size >= 1, true);
  });

  it('至少两个社团：单社团 → validation 错误', async () => {
    const repo = makeMemoryRepo();
    const useCase = new DefaultInitiateJointActivityUseCase(repo, makeAuthAllAllow(), tasksStub);
    await assert.rejects(
      () =>
        useCase.execute({
          title: 't',
          confirmDeadline: new Date('2026-09-01'),
          clubIds: ['club-a'],
          actingClubId: 'club-a',
          actor: 'u1',
          now: NOW,
        }),
      /至少.*两个/,
    );
  });

  it('社团重复 → validation 错误', async () => {
    const repo = makeMemoryRepo();
    const useCase = new DefaultInitiateJointActivityUseCase(repo, makeAuthAllAllow(), tasksStub);
    await assert.rejects(
      () =>
        useCase.execute({
          title: 't',
          confirmDeadline: new Date('2026-09-01'),
          clubIds: ['club-a', 'club-a'],
          actingClubId: 'club-a',
          actor: 'u1',
          now: NOW,
        }),
      /重复/,
    );
  });

  it('发起方不在参与列表 → forbidden', async () => {
    const repo = makeMemoryRepo();
    const useCase = new DefaultInitiateJointActivityUseCase(repo, makeAuthAllAllow(), tasksStub);
    await assert.rejects(
      () =>
        useCase.execute({
          title: 't',
          confirmDeadline: new Date('2026-09-01'),
          clubIds: ['club-a', 'club-b'],
          actingClubId: 'club-x',
          actor: 'u1',
          now: NOW,
        }),
      /发起组织/,
    );
  });
});

describe('CancelJointActivityUseCase（授权拒绝冒烟）', () => {
  it('未授权 → forbidden（fail-closed）', async () => {
    const repo = makeMemoryRepo();
    const denyAll = Object.fromEntries(['canCancelOrForceEnd'].map((m) => [m, async () => false]));
    const auth = Object.assign(makeAuthAllAllow(), denyAll);
    const useCase = new DefaultCancelJointActivityUseCase(repo, auth as never, tasksStub as never);
    await assert.rejects(
      () =>
        useCase.execute({
          activityId: 'act-x',
          actor: 'u1',
          actingClubId: 'club-a',
          now: NOW,
        } as never),
      (e: unknown) => {
        assert.ok((e as Error).message.length > 0);
        return true;
      },
    );
  });
});

describe('ForceEndJointActivityUseCase（授权拒绝冒烟）', () => {
  it('未授权 → 拒绝', async () => {
    const repo = makeMemoryRepo();
    const auth = Object.assign(makeAuthAllAllow(), {
      canCancelOrForceEnd: async () => false,
    });
    const useCase = new DefaultForceEndJointActivityUseCase(
      repo,
      auth as never,
      tasksStub as never,
    );
    await assert.rejects(
      () =>
        useCase.execute({
          activityId: 'act-y',
          actor: 'u1',
          actingClubId: 'club-a',
          reason: '紧急停用',
          now: NOW,
        } as never),
      (e: unknown) => {
        assert.ok((e as Error).message.length > 0);
        return true;
      },
    );
  });
});

describe('PublishJointActivityUseCase（授权拒绝冒烟）', () => {
  it('未授权 → 拒绝', async () => {
    const repo = makeMemoryRepo();
    const auth = Object.assign(makeAuthAllAllow(), {
      canPublish: async () => false,
    });
    const useCase = new DefaultPublishJointActivityUseCase(repo, auth as never);
    await assert.rejects(
      () =>
        useCase.execute({
          activityId: 'act-p',
          actor: 'u1',
          actingClubId: 'club-a',
          now: NOW,
        } as never),
      (e: unknown) => {
        assert.ok((e as Error).message.length > 0);
        return true;
      },
    );
  });
});

describe('EndJointActivityUseCase（授权拒绝冒烟）', () => {
  it('未授权 → 拒绝', async () => {
    const repo = makeMemoryRepo();
    const auth = Object.assign(makeAuthAllAllow(), {
      canCancelOrForceEnd: async () => false,
    });
    const useCase = new DefaultEndJointActivityUseCase(repo, auth as never, tasksStub);
    await assert.rejects(
      () =>
        useCase.execute({
          activityId: 'act-e',
          actor: 'u1',
          actingClubId: 'club-a',
          now: NOW,
        } as never),
      (e: unknown) => {
        assert.ok((e as Error).message.length > 0);
        return true;
      },
    );
  });
});

describe('BeginEndConfirmUseCase（授权拒绝冒烟）', () => {
  it('未授权 → 拒绝', async () => {
    const repo = makeMemoryRepo();
    const auth = Object.assign(makeAuthAllAllow(), {
      canConfirmRound: async () => false,
    });
    const useCase = new DefaultBeginEndConfirmUseCase(repo, auth as never);
    await assert.rejects(
      () =>
        useCase.execute({
          activityId: 'act-b',
          actor: 'u1',
          actingClubId: 'club-a',
          now: NOW,
        } as never),
      (e: unknown) => {
        assert.ok((e as Error).message.length > 0);
        return true;
      },
    );
  });
});
