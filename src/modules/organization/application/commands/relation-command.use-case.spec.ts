import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { createClubSpace } from '../../domain/models/club-space';
import { PermissionCatalog } from '../../domain/models/permission-template';
import { RelationCommandUseCase } from './relation-command.use-case';
import {
  InMemoryCasdoorPort,
  InMemoryClubStore,
  InMemoryGroupMappingRegistry,
  InMemoryJobScheduler,
  InMemoryNotificationPort,
  InMemoryRelationCommandStore,
} from '../../infrastructure/in-memory/memory-implementations';
import type { CurrentPermissionsPort, GroupMappingRegistry } from '../ports';

class MutablePermissions implements CurrentPermissionsPort {
  perms = new Map<string, string[]>([['club-acm-1', [PermissionCatalog.CLUB_MEMBER_MANAGE]]]);

  async effectiveForClub(userId: string, clubId: string): Promise<string[]> {
    return this.perms.get(clubId) ?? [];
  }

  async isPlatformSuperAdmin(): Promise<boolean> {
    return false;
  }

  async primaryRoleAt(): Promise<string> {
    return 'club-acm/人事组';
  }
}

function buildHarness(options?: {
  mappings?: GroupMappingRegistry;
  casdoor?: InMemoryCasdoorPort;
}) {
  const casdoor =
    options?.casdoor ??
    new InMemoryCasdoorPort({
      groups: [
        {
          ref: { owner: 'club-acm', name: 'ACM社团' },
          displayName: 'ACM社团',
          parentRef: null,
          memberIds: ['u_a', 'u_b', 'u_c'],
        },
        {
          ref: { owner: 'club-acm', name: '宣传部' },
          displayName: '宣传部',
          parentRef: { owner: 'club-acm', name: 'ACM社团' },
          memberIds: ['u_a', 'u_b'],
        },
      ],
    });
  const clubs = new InMemoryClubStore();
  const relationStore = new InMemoryRelationCommandStore();
  const mappingRegistry = options?.mappings ?? new InMemoryGroupMappingRegistry();
  const scheduler = new InMemoryJobScheduler();
  const notifications = new InMemoryNotificationPort();
  const permissions = new MutablePermissions();
  const useCase = new RelationCommandUseCase(
    relationStore,
    clubs,
    casdoor,
    mappingRegistry,
    scheduler,
    notifications,
    permissions,
  );

  const club = createClubSpace({
    id: 'club-acm-1',
    name: 'ACM社团',
    description: '',
    candidate: { owner: 'club-acm', name: 'ACM社团' },
    actor: 'u_root',
    now: new Date('2026-07-01T00:00:00.000Z'),
  });
  club.status = 'enabled';
  club.readonly = false;
  club.clubGroup = { owner: 'club-acm', name: 'ACM社团' };

  return { casdoor, clubs, relationStore, mappingRegistry, scheduler, useCase, club, permissions };
}

describe('RelationCommandUseCase', () => {
  let h: ReturnType<typeof buildHarness>;

  beforeEach(async () => {
    h = buildHarness();
    await h.clubs.save(h.club);
  });

  const baseInput = {
    clubId: 'club-acm-1',
    type: 'appoint_position' as const,
    subjectId: 'u_c',
    targetGroups: [{ ref: { owner: 'club-acm', name: '宣传部' }, kind: 'add' as const }],
    objectVersion: 3,
    idempotencyKey: 'rel:appoint:u_c:1',
    submittedBy: 'u_b',
  };

  it('submit：成员前提满足 → 待执行并登记执行任务', async () => {
    const cmd = await h.useCase.submit(baseInput, new Date('2026-08-01T00:00:00.000Z'));
    assert.equal(cmd.status, 'pending_execution');
    const tasks = await h.scheduler.listDue(new Date('2026-08-01T00:00:00.000Z'));
    assert.ok(tasks.some((t) => t.refId === cmd.id));
  });

  it('submit：目标非社团成员 → 拒绝（ORG-021）', async () => {
    await assert.rejects(
      () =>
        h.useCase.submit(
          { ...baseInput, subjectId: 'not_a_member', idempotencyKey: 'rel:appoint:x' },
          new Date('2026-08-01T00:00:00.000Z'),
        ),
      (e: Error) => e.message.includes('尚不属于社团 Group'),
    );
  });

  it('handleReadback：写入后未确认且在 15 分钟窗口内 → 重试（attemptCount 递增）', async () => {
    const cmd = await h.useCase.submit(baseInput, new Date('2026-08-01T00:00:00.000Z'));
    const processing = {
      ...cmd,
      status: 'processing' as const,
      retryDeadline: '2026-08-01T00:00:10.000Z',
    };
    await h.relationStore.save(processing);

    const now = new Date('2026-08-01T00:05:00.000Z');
    const after = await h.useCase.handleReadback({ commandId: cmd.id, now }, {
      membersByGroup: {},
    } as Parameters<typeof h.useCase.handleReadback>[1]);
    // 目标组内确认失败 → 窗口内 → retry_attempt
    assert.equal(after.status, 'processing');
  });

  it('systemConfirmReadback：写入未确认且在窗口内 → 触发 write_started 后进入 retry_attempt', async () => {
    const cmd = await h.useCase.submit(baseInput, new Date('2026-08-01T00:00:00.000Z'));
    const after = await h.useCase.systemConfirmReadback({
      commandId: cmd.id,
      clubId: cmd.clubId,
      now: new Date('2026-08-01T00:05:00.000Z'),
    });
    assert.equal(after.status, 'processing');
    assert.equal(after.attemptCount, 2);
    assert.ok(after.retryDeadline);
  });

  it('handleReadback：超出 15 分钟窗口 → final_failure 保持原关系有效', async () => {
    const cmd = await h.useCase.submit(baseInput, new Date('2026-08-01T00:00:00.000Z'));
    const processing = {
      ...cmd,
      status: 'processing' as const,
      retryDeadline: '2026-08-01T00:00:10.000Z',
      attemptCount: 2,
    };
    await h.relationStore.save(processing);

    const now = new Date('2026-08-01T00:30:00.000Z');
    const after = await h.useCase.handleReadback(
      { commandId: cmd.id, now },
      { membersByGroup: {} },
    );
    assert.equal(after.status, 'failed_original_preserved');
    assert.ok(after.failureReason?.includes('原关系保持有效'));
  });

  it('systemConfirmReadback：写入后回读确认 → 触发 write_started 并正式生效', async () => {
    const cmd = await h.useCase.submit(baseInput, new Date('2026-08-01T00:00:00.000Z'));
    // 目标成员已写入宣传部
    await h.casdoor.writeMembership({
      ref: { owner: 'club-acm', name: '宣传部' },
      subjectId: 'u_c',
      action: 'add',
      requestId: 'req-confirm',
    });
    const after = await h.useCase.systemConfirmReadback({
      commandId: cmd.id,
      clubId: cmd.clubId,
      now: new Date('2026-08-01T00:00:05.000Z'),
    });
    assert.equal(after.status, 'readback_confirmed');
    assert.ok(after.confirmedAt);
    assert.equal(after.attemptCount, 1);
    assert.ok(after.retryDeadline);
  });

  it('submit：提交者无成员管理权限 → 拒绝（ORG-027）', async () => {
    h.permissions.perms.set('club-acm-1', []);
    await assert.rejects(
      () => h.useCase.submit(baseInput, new Date('2026-08-01T00:00:00.000Z')),
      (e: Error) => e.message.includes('无成员关系管理权限'),
    );
  });

  it('撤销最后一名负责人 → 拒绝（ORG-024 零负责人窗口）', async () => {
    // 设负责人 Group 为宣传部，并将 u_b 移出使其仅剩 u_a 一名负责人
    h.club.leaderGroup = { owner: 'club-acm', name: '宣传部' };
    await h.clubs.save(h.club);
    await h.casdoor.writeMembership({
      ref: { owner: 'club-acm', name: '宣传部' },
      subjectId: 'u_b',
      action: 'remove',
      requestId: 'req-rm-u_b',
    });
    await assert.rejects(
      () =>
        h.useCase.submit(
          {
            clubId: 'club-acm-1',
            type: 'revoke_position',
            subjectId: 'u_a',
            targetGroups: [{ ref: { owner: 'club-acm', name: '宣传部' }, kind: 'remove' }],
            objectVersion: 1,
            idempotencyKey: 'revoke-last-leader',
            submittedBy: 'u_b',
          },
          new Date('2026-08-01T00:00:00.000Z'),
        ),
      (e: Error) => e.message.includes('最后一名负责人'),
    );
  });

  it('manualRetry：重试者无成员管理权限 → 拒绝（ORG-027 人工重试行）', async () => {
    const cmd = await h.useCase.submit(baseInput, new Date('2026-08-01T00:00:00.000Z'));
    // 进入可人工重试的失败状态（failed_original_preserved）
    const failed = { ...cmd, status: 'failed_original_preserved' as const };
    await h.relationStore.save(failed);
    // 撤销权限后再人工重试
    h.permissions.perms.set('club-acm-1', []);
    await assert.rejects(
      () =>
        h.useCase.manualRetry({
          commandId: cmd.id,
          clubId: cmd.clubId,
          actor: 'u_b',
          now: new Date('2026-08-01T00:01:00.000Z'),
        }),
      (e: Error) => e.message.includes('人工重试前须重新鉴权'),
    );
  });

  it('内存桩：旧版本（attemptCount 回退）写入被乐观锁拒绝', async () => {
    const cmd = await h.useCase.submit(baseInput, new Date('2026-08-01T00:00:00.000Z'));
    const newer = { ...cmd, attemptCount: cmd.attemptCount + 5 };
    await h.relationStore.save(newer);
    // 用更低的 attemptCount 覆盖已存在的更高版本 → 拒绝
    await assert.rejects(
      () => h.relationStore.save({ ...cmd, status: 'processing' as const }),
      (e: Error) => e.message.includes('乐观锁'),
    );
  });

  // -------------------------------------------------------------------------
  // buildSteps：按 Group 用途排序 + 真实原关系回读
  // -------------------------------------------------------------------------

  async function setupWithMappings(
    mappings: Array<{
      ref: { owner: string; name: string };
      purpose: 'club' | 'department' | 'position';
    }>,
  ) {
    const registry = new InMemoryGroupMappingRegistry();
    const h2 = buildHarness({ mappings: registry });
    for (const m of mappings) {
      await registry.save({
        ref: m.ref,
        clubId: 'club-acm-1',
        purpose: m.purpose,
        departmentId: null,
        positionId: null,
        mappingVersion: 1,
      });
    }
    // ensure club is saved (parent beforeEach already did, but harness was rebuilt)
    await h2.clubs.save(h2.club);
    return h2;
  }

  it('buildSteps：所有 remove 必须先于 add（先撤销后授予，ORG-027/CAS-Q-001）', async () => {
    // 部门/职位用途都已登记，社团用途也登记
    const h2 = await setupWithMappings([
      { ref: { owner: 'club-acm', name: 'ACM社团' }, purpose: 'club' },
      { ref: { owner: 'club-acm', name: '宣传部' }, purpose: 'department' },
    ]);
    const cmd = await h2.useCase.submit(
      {
        ...baseInput,
        targetGroups: [
          { ref: { owner: 'club-acm', name: '宣传部' }, kind: 'add' },
          { ref: { owner: 'club-acm', name: 'ACM社团' }, kind: 'add' },
        ],
      },
      new Date('2026-08-01T00:00:00.000Z'),
    );
    // 全部 add，无 remove 步；排序由用途决定
    const orderedKinds = cmd.targetRelation.map((s) => s.kind);
    const orderedRefs = cmd.targetRelation.map(
      (s) => `${s.targetGroup.owner}/${s.targetGroup.name}`,
    );
    assert.deepEqual(orderedKinds, ['add_member', 'add_member']);
    // club 应先于 department
    assert.deepEqual(orderedRefs, ['club-acm/ACM社团', 'club-acm/宣传部']);
  });

  it('buildSteps：add 步内按用途升序（club < department < position，未识别置末）', async () => {
    const h2 = await setupWithMappings([
      { ref: { owner: 'club-acm', name: 'ACM社团' }, purpose: 'club' },
      { ref: { owner: 'club-acm', name: '宣传部' }, purpose: 'department' },
      { ref: { owner: 'club-acm', name: '副会长' }, purpose: 'position' },
      // 杂务组 不登记（未识别）
    ]);
    // 准备 4 个 Group（社团/部门/职位/未登记）到 h2 自身的 casdoor
    h2.casdoor.addGroup({
      ref: { owner: 'club-acm', name: '副会长' },
      displayName: '副会长',
      parentRef: { owner: 'club-acm', name: 'ACM社团' },
      memberIds: [],
    });
    h2.casdoor.addGroup({
      ref: { owner: 'club-acm', name: '杂务组' },
      displayName: '杂务组',
      parentRef: { owner: 'club-acm', name: 'ACM社团' },
      memberIds: [],
    });
    const cmd = await h2.useCase.submit(
      {
        ...baseInput,
        targetGroups: [
          { ref: { owner: 'club-acm', name: '副会长' }, kind: 'add' },
          { ref: { owner: 'club-acm', name: '杂务组' }, kind: 'add' },
          { ref: { owner: 'club-acm', name: 'ACM社团' }, kind: 'add' },
          { ref: { owner: 'club-acm', name: '宣传部' }, kind: 'add' },
        ],
      },
      new Date('2026-08-01T00:00:00.000Z'),
    );
    const orderedRefs = cmd.targetRelation.map(
      (s) => `${s.targetGroup.owner}/${s.targetGroup.name}`,
    );
    assert.deepEqual(orderedRefs, [
      'club-acm/ACM社团', // club (rank 1)
      'club-acm/宣传部', // department (rank 2)
      'club-acm/副会长', // position (rank 3)
      'club-acm/杂务组', // unknown (rank 4)
    ]);
  });

  it('buildSteps：remove 与 add 混合时 remove 全部先执行（即使 add 用 position 用途）', async () => {
    const h2 = await setupWithMappings([
      { ref: { owner: 'club-acm', name: 'ACM社团' }, purpose: 'club' },
      { ref: { owner: 'club-acm', name: '宣传部' }, purpose: 'department' },
    ]);
    h2.casdoor.addGroup({
      ref: { owner: 'club-acm', name: '副会长' },
      displayName: '副会长',
      parentRef: { owner: 'club-acm', name: 'ACM社团' },
      memberIds: [],
    });
    await h2.mappingRegistry.save({
      ref: { owner: 'club-acm', name: '副会长' },
      clubId: 'club-acm-1',
      purpose: 'position',
      departmentId: null,
      positionId: null,
      mappingVersion: 1,
    });
    const cmd = await h2.useCase.submit(
      {
        ...baseInput,
        targetGroups: [
          { ref: { owner: 'club-acm', name: '宣传部' }, kind: 'add' },
          { ref: { owner: 'club-acm', name: '副会长' }, kind: 'add' },
          { ref: { owner: 'club-acm', name: 'ACM社团' }, kind: 'remove' },
        ],
      },
      new Date('2026-08-01T00:00:00.000Z'),
    );
    const orderedKinds = cmd.targetRelation.map((s) => s.kind);
    const orderedRefs = cmd.targetRelation.map(
      (s) => `${s.targetGroup.owner}/${s.targetGroup.name}`,
    );
    assert.deepEqual(orderedKinds, ['remove_member', 'add_member', 'add_member']);
    assert.deepEqual(orderedRefs, [
      'club-acm/ACM社团', // remove (rank 0)
      'club-acm/宣传部', // add department (rank 2)
      'club-acm/副会长', // add position (rank 3)
    ]);
  });

  it('buildSteps：原关系快照回读 Casdoor 实际成员（confirmed=当前在，failed=当前不在）', async () => {
    // 初始：u_c 不在 ACM社团 也不在 宣传部（u_c 是社团成员但不在宣传部）
    const h2 = await setupWithMappings([
      { ref: { owner: 'club-acm', name: 'ACM社团' }, purpose: 'club' },
      { ref: { owner: 'club-acm', name: '宣传部' }, purpose: 'department' },
    ]);
    // 让 u_c 先在 ACM社团（已是），在 宣传部 仍不在
    // （初始 InMemoryCasdoorPort 已将 u_c 列为 ACM社团 成员，但不在 宣传部）
    const cmd = await h2.useCase.submit(
      {
        ...baseInput,
        targetGroups: [
          { ref: { owner: 'club-acm', name: 'ACM社团' }, kind: 'remove' },
          { ref: { owner: 'club-acm', name: '宣传部' }, kind: 'add' },
        ],
      },
      new Date('2026-08-01T00:00:00.000Z'),
    );
    // ACM社团 remove：u_c 当前是成员 → original.result = 'confirmed'
    // 宣传部 add：u_c 当前不是成员 → original.result = 'failed'
    const originalByRef = new Map(
      cmd.originalRelation.map((s) => [`${s.targetGroup.owner}/${s.targetGroup.name}`, s.result]),
    );
    assert.equal(originalByRef.get('club-acm/ACM社团'), 'confirmed');
    assert.equal(originalByRef.get('club-acm/宣传部'), 'failed');
  });

  it('buildSteps：原关系快照与目标关系并行回读（共享 idempotencyKey + stepId）', async () => {
    const h2 = await setupWithMappings([
      { ref: { owner: 'club-acm', name: 'ACM社团' }, purpose: 'club' },
      { ref: { owner: 'club-acm', name: '宣传部' }, purpose: 'department' },
    ]);
    const cmd = await h2.useCase.submit(
      {
        ...baseInput,
        idempotencyKey: 'rel:combined:test',
        targetGroups: [
          { ref: { owner: 'club-acm', name: 'ACM社团' }, kind: 'remove' },
          { ref: { owner: 'club-acm', name: '宣传部' }, kind: 'add' },
        ],
      },
      new Date('2026-08-01T00:00:00.000Z'),
    );
    // originalRelation 与 targetRelation 共享 stepId + 步骤级 idempotencyKey
    const original = new Map(cmd.originalRelation.map((s) => [s.stepId, s]));
    const target = new Map(cmd.targetRelation.map((s) => [s.stepId, s]));
    for (const [stepId, targetStep] of target.entries()) {
      const originalStep = original.get(stepId);
      assert.ok(originalStep, `originalRelation 缺少 stepId ${stepId}`);
      assert.equal(originalStep.idempotencyKey, targetStep.idempotencyKey);
      assert.equal(originalStep.kind, targetStep.kind);
    }
  });

  it('buildSteps：目标 Group 缺失时优雅降级而非抛裸 Error（与 readback 容错一致）', async () => {
    // 目标 Group「不存在」：不在 Casdoor 中（也未登记用途，属可达场景）
    const h2 = await setupWithMappings([]);
    const cmd = await h2.useCase.submit(
      {
        ...baseInput,
        idempotencyKey: 'rel:missing-group:test',
        targetGroups: [{ ref: { owner: 'club-acm', name: '不存在的组' }, kind: 'add' }],
      },
      new Date('2026-08-01T00:00:00.000Z'),
    );
    // 未抛裸 Error；缺失 Group 视为「空成员集」→ present=false → original.result='failed'
    assert.equal(cmd.targetRelation.length, 1);
    assert.equal(cmd.targetRelation[0].targetGroup.name, '不存在的组');
    assert.equal(cmd.originalRelation.length, 1);
    assert.equal(cmd.originalRelation[0].result, 'failed');
  });

  it('buildSteps：目标 Group 远程读取抛异常时收敛为领域错误而非裸 Error', async () => {
    // 端口级异常（模拟真实 Casdoor 网络/权限故障）不应以裸 Error 冒出，
    // 应映射为可重试的领域错误，保证 submit 失败路径可控（ORG-027）
    const base = buildHarness();
    const flaky = Object.create(base.casdoor) as InMemoryCasdoorPort;
    // 仅目标 Group（宣传部）读取抛错；社团 Group 读取保持正常，以通过成员前提校验
    flaky.getGroupMembers = async (ref: { owner: string; name: string }) => {
      if (ref.name === '宣传部') throw new Error('simulated casdoor failure');
      return base.casdoor.getGroupMembers(ref);
    };
    const h2 = buildHarness({ casdoor: flaky });
    await h2.clubs.save(h2.club);
    await assert.rejects(
      h2.useCase.submit(
        {
          ...baseInput,
          idempotencyKey: 'rel:readback-failure:test',
          targetGroups: [{ ref: { owner: 'club-acm', name: '宣传部' }, kind: 'add' }],
        },
        new Date('2026-08-01T00:00:00.000Z'),
      ),
      (err: unknown) => {
        // 抛出的必须是领域错误（orgError），而非模拟的裸 Error
        assert.notEqual((err as Error).message, 'simulated casdoor failure');
        assert.match((err as Error).message, /回读目标 Group 实况\/用途失败/);
        return true;
      },
    );
  });

  it('submit：buildSteps 后二次判重拦截并发冲突（TOCTOU 窗口收窄，IFC-ERR-007）', async () => {
    const h2 = await setupWithMappings([
      { ref: { owner: 'club-acm', name: 'ACM社团' }, purpose: 'club' },
    ]);
    // 先落库一条"处理中"命令，模拟并发方在 buildSteps 远程回读期间抢先落库
    const existing = await h2.useCase.submit(
      { ...baseInput, idempotencyKey: 'rel:concurrent-other' },
      new Date('2026-08-01T00:00:00.000Z'),
    );
    // 让这条命令进入 processing（处理中）
    await h2.relationStore.save({ ...existing, status: 'processing' as const });
    // 再次以同一 subject、不同幂等键提交 → buildSteps 后的二次判重应拦截
    await assert.rejects(
      h2.useCase.submit(
        { ...baseInput, idempotencyKey: 'rel:concurrent-this' },
        new Date('2026-08-01T00:00:00.000Z'),
      ),
      (e: Error) => e.message.includes('禁止并发冲突操作'),
    );
    // 同一幂等键重试 → 命中已有命令并返回（幂等）
    const retried = await h2.useCase.submit(
      { ...baseInput, idempotencyKey: 'rel:concurrent-other' },
      new Date('2026-08-01T00:00:00.000Z'),
    );
    assert.equal(retried.id, existing.id);
  });
});
