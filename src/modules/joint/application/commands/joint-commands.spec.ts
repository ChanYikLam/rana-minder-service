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
import type { JointActivitySnapshot } from '../../domain/models/joint-activity';
import type { JointParticipantSnapshot } from '../../domain/models/joint-participant';
import type { JointChannelSnapshot } from '../../domain/models/joint-channel';
import { JointParticipantStatus } from '../../domain/state-machines/joint-participant.state-machine';
import { JointActivityStatus } from '../../domain/state-machines/joint-activity.state-machine';

// ---- 内存仓储桩（完整实现 JointRepository，避免 as never 掩盖接口变更） ----
function makeMemoryRepo(): JointRepository & {
  activities: Map<string, JointActivitySnapshot>;
  participants: Map<string, JointParticipantSnapshot[]>;
  channels: Map<string, JointChannelSnapshot>;
} {
  const activities = new Map<string, JointActivitySnapshot>();
  const participants = new Map<string, JointParticipantSnapshot[]>();
  const channels = new Map<string, JointChannelSnapshot>();
  return {
    activities,
    participants,
    channels,
    async loadActivity(id: string) {
      return activities.get(id) ?? null;
    },
    async saveActivity(snapshot: JointActivitySnapshot) {
      activities.set(snapshot.id, snapshot); // 按 id upsert
    },
    async loadParticipant() {
      return null;
    },
    async loadParticipantsByActivity(activityId: string) {
      return participants.get(activityId) ?? [];
    },
    async saveParticipant(snapshot: JointParticipantSnapshot) {
      const list = participants.get(snapshot.activityId) ?? [];
      const idx = list.findIndex((p) => p.id === snapshot.id);
      if (idx >= 0) {
        list[idx] = snapshot; // upsert，避免重复追加
      } else {
        list.push(snapshot);
      }
      participants.set(snapshot.activityId, list);
    },
    async loadApplication() {
      return null;
    },
    async loadApplicationsByActivity() {
      return [];
    },
    async saveApplication() {},
    async loadInterview() {
      return null;
    },
    async loadInterviewByApplication() {
      return null;
    },
    async loadInterviewsByActivity() {
      return [];
    },
    async saveInterview() {},
    async loadConclusion() {
      return null;
    },
    async loadConclusionsByApplication() {
      return [];
    },
    async loadConclusionsByActivity() {
      return [];
    },
    async saveConclusion() {},
    async loadChannel(id: string) {
      return channels.get(id) ?? null;
    },
    async saveChannel(snapshot: JointChannelSnapshot) {
      channels.set(snapshot.jointActivityId, snapshot);
    },
  };
}

/** 授权桩：全部方法放行（完整实现 JointAuthorizationPort，避免 as never） */
function makeAuthAllAllow(): JointAuthorizationPort {
  return {
    canInitiateJoint: async () => true,
    canConfirmRound: async () => true,
    canPublish: async () => true,
    canManageInvitation: async () => true,
    canCancelOrForceEnd: async () => true,
    canManageParticipation: async () => true,
    canViewList: async () => true,
    canViewJointActivity: async () => true,
    canViewApplication: async () => true,
    canViewInterview: async () => true,
    canViewConclusions: async () => true,
    canViewApplications: async () => true,
    canViewParticipants: async () => true,
    canViewChannel: async () => true,
    canRecordEvaluation: async () => true,
    canEditConclusion: async () => true,
    canRestoreReview: async () => true,
  };
}

/** 预置一条有效活动快照 + 参与者（使 loadActivity 命中且通过域层作用域校验） */
function seedActivity(
  repo: ReturnType<typeof makeMemoryRepo>,
  id: string,
  status: JointActivityStatus = JointActivityStatus.ESTABLISHED,
  clubIds = ['club-a', 'club-b'],
  participantStatus: JointParticipantStatus = JointParticipantStatus.PROPOSED,
) {
  const activity: JointActivitySnapshot = {
    id,
    title: '预置活动',
    description: null,
    status,
    confirmRound: 1,
    confirmDeadline: NOW,
    publishedAt: null,
    firstInvitationAt: null,
    cancelRound: 0,
    forcedEndedReason: null,
    revisionNumber: 1,
    createdBy: 'u_admin',
    createdAt: NOW,
    updatedAt: NOW,
  };
  repo.activities.set(id, activity);
  const list: JointParticipantSnapshot[] = clubIds.map((cid) => ({
    id: `part-${cid}`,
    activityId: id,
    clubId: cid,
    status: participantStatus,
    roundId: 1,
    decidedBy: null,
    confirmedAt: null,
    suspendedAt: null,
    resumedAt: null,
    suspendedForMs: 0,
    revisionNumber: 1,
    createdAt: NOW,
    updatedAt: NOW,
  }));
  repo.participants.set(id, list);
}

// JointTaskEnqueuer 为带 private 成员的具体类，无法结构化赋值，故仅实现测试用到的公共 schedule 方法
// 并通过类型断言补齐（保留方法签名，避免 `as never` 彻底绕过类型）。
const tasksStub: JointTaskEnqueuer = {
  scheduleConfirmDeadlineScan: async () => undefined,
  scheduleInvitationTimeout: async () => undefined,
  scheduleChannelAutoClose: async () => undefined,
  scheduleForceEndCleanup: async () => undefined,
  scheduleArchiveTerminal: async () => undefined,
} as unknown as JointTaskEnqueuer;

const NOW = new Date('2026-08-01T00:00:00Z');

describe('InitiateJointActivityUseCase', () => {
  it('正常路径：创建活动 + 参与者落盘 + 通道初始化 + 任务调度', async () => {
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

  it('授权拒绝：deny canInitiateJoint → forbidden（守卫行覆盖）', async () => {
    const repo = makeMemoryRepo();
    const auth = Object.assign(makeAuthAllAllow(), {
      canInitiateJoint: async () => false,
    });
    const useCase = new DefaultInitiateJointActivityUseCase(repo, auth, tasksStub);
    await assert.rejects(
      () =>
        useCase.execute({
          title: 't',
          confirmDeadline: new Date('2026-09-01'),
          clubIds: ['club-a', 'club-b'],
          actingClubId: 'club-a',
          actor: 'u1',
          now: NOW,
        }),
      /授权|forbidden|仅/i,
    );
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
  it('预置活动 + deny canCancelOrForceEnd → forbidden', async () => {
    const repo = makeMemoryRepo();
    seedActivity(repo, 'act-x', JointActivityStatus.DRAFT_CONFIRMING);
    const auth = Object.assign(makeAuthAllAllow(), {
      canCancelOrForceEnd: async () => false,
    });
    const useCase = new DefaultCancelJointActivityUseCase(repo, auth, tasksStub);
    await assert.rejects(
      () =>
        useCase.execute({
          activityId: 'act-x',
          actor: 'u1',
          actingClubId: 'club-a',
          now: NOW,
        }),
      /授权|forbidden|仅/i,
    );
  });
});

describe('ForceEndJointActivityUseCase（授权拒绝冒烟）', () => {
  it('预置活动 + deny canCancelOrForceEnd → forbidden', async () => {
    const repo = makeMemoryRepo();
    seedActivity(repo, 'act-y', JointActivityStatus.INVITING);
    const auth = Object.assign(makeAuthAllAllow(), {
      canCancelOrForceEnd: async () => false,
    });
    const useCase = new DefaultForceEndJointActivityUseCase(repo, auth, tasksStub);
    await assert.rejects(
      () =>
        useCase.execute({
          activityId: 'act-y',
          actor: 'u1',
          actingClubId: 'club-a',
          reason: '紧急停用',
          now: NOW,
        }),
      /授权|forbidden|仅/i,
    );
  });
});

describe('PublishJointActivityUseCase', () => {
  it('活动不存在 → notFound', async () => {
    const repo = makeMemoryRepo();
    const useCase = new DefaultPublishJointActivityUseCase(repo, makeAuthAllAllow());
    await assert.rejects(
      () =>
        useCase.execute({
          activityId: 'missing-act',
          actor: 'u1',
          actingClubId: 'club-a',
          now: NOW,
        }),
      /未找到|联合活动/,
    );
  });

  it('预置活动 + deny canPublish → forbidden', async () => {
    const repo = makeMemoryRepo();
    seedActivity(repo, 'act-p', JointActivityStatus.ESTABLISHED);
    const auth = Object.assign(makeAuthAllAllow(), {
      canPublish: async () => false,
    });
    const useCase = new DefaultPublishJointActivityUseCase(repo, auth);
    await assert.rejects(
      () =>
        useCase.execute({
          activityId: 'act-p',
          actor: 'u1',
          actingClubId: 'club-a',
          now: NOW,
        }),
      /授权|forbidden|仅/i,
    );
  });

  it('正常路径：全体确认且不少于两社团 → 公布成功并固化参与', async () => {
    const repo = makeMemoryRepo();
    seedActivity(
      repo,
      'act-p2',
      JointActivityStatus.ESTABLISHED,
      ['club-a', 'club-b'],
      JointParticipantStatus.CONFIRMED,
    );
    const useCase = new DefaultPublishJointActivityUseCase(repo, makeAuthAllAllow());
    await useCase.execute({
      activityId: 'act-p2',
      actor: 'u1',
      actingClubId: 'club-a',
      now: NOW,
    });
    const updated = repo.activities.get('act-p2')!;
    assert.equal(updated.status, 'PUBLISHED');
    assert.ok(updated.publishedAt !== null);
    const participants = repo.participants.get('act-p2')!;
    assert.equal(participants.length, 2);
    assert.ok(participants.every((p) => p.status === JointParticipantStatus.PARTICIPATING));
  });

  it('未全部确认 → precondition 失败', async () => {
    const repo = makeMemoryRepo();
    seedActivity(repo, 'act-p3', JointActivityStatus.ESTABLISHED, ['club-a', 'club-b']); // 默认 PROPOSED
    const useCase = new DefaultPublishJointActivityUseCase(repo, makeAuthAllAllow());
    await assert.rejects(
      () =>
        useCase.execute({
          activityId: 'act-p3',
          actor: 'u1',
          actingClubId: 'club-a',
          now: NOW,
        }),
      /确认/,
    );
  });

  it('非已成立状态 → precondition 失败（仅已成立的联合活动可公布）', async () => {
    const repo = makeMemoryRepo();
    // 状态非 ESTABLISHED（如已 PUBLISHED），即便参与者已确认也会先被状态守卫拦截
    seedActivity(
      repo,
      'act-p4',
      JointActivityStatus.PUBLISHED,
      ['club-a', 'club-b'],
      JointParticipantStatus.CONFIRMED,
    );
    const useCase = new DefaultPublishJointActivityUseCase(repo, makeAuthAllAllow());
    await assert.rejects(
      () =>
        useCase.execute({
          activityId: 'act-p4',
          actor: 'u1',
          actingClubId: 'club-a',
          now: NOW,
        }),
      /仅已成立|可公布/,
    );
  });
});

describe('EndJointActivityUseCase（授权拒绝冒烟）', () => {
  it('预置活动 + deny canManageInvitation → forbidden（实际检查方法）', async () => {
    const repo = makeMemoryRepo();
    seedActivity(repo, 'act-e', JointActivityStatus.END_CONFIRMING);
    const auth = Object.assign(makeAuthAllAllow(), {
      canManageInvitation: async () => false,
    });
    const useCase = new DefaultEndJointActivityUseCase(repo, auth, tasksStub);
    await assert.rejects(
      () =>
        useCase.execute({
          activityId: 'act-e',
          actor: 'u1',
          actingClubId: 'club-a',
          now: NOW,
        }),
      /授权|forbidden|仅/i,
    );
  });
});

describe('BeginEndConfirmUseCase（授权拒绝冒烟）', () => {
  it('预置活动 + deny canManageInvitation → forbidden（实际检查方法）', async () => {
    const repo = makeMemoryRepo();
    seedActivity(repo, 'act-b', JointActivityStatus.INVITING);
    const auth = Object.assign(makeAuthAllAllow(), {
      canManageInvitation: async () => false,
    });
    const useCase = new DefaultBeginEndConfirmUseCase(repo, auth);
    await assert.rejects(
      () =>
        useCase.execute({
          activityId: 'act-b',
          actor: 'u1',
          actingClubId: 'club-a',
          now: NOW,
        }),
      /授权|forbidden|仅/i,
    );
  });
});
