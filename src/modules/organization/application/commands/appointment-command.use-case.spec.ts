import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { createClubSpace } from '../../domain/models/club-space';
import { PermissionCatalog } from '../../domain/models/permission-template';
import { AppointmentCommandUseCase } from './appointment-command.use-case';
import { RelationCommandUseCase } from './relation-command.use-case';
import {
  InMemoryAppointmentCommandStore,
  InMemoryCasdoorPort,
  InMemoryClubStore,
  InMemoryGroupMappingRegistry,
  InMemoryJobScheduler,
  InMemoryNotificationPort,
  InMemoryRelationCommandStore,
} from '../../infrastructure/in-memory/memory-implementations';
import type { CurrentPermissionsPort } from '../ports';

class MutablePermissions implements CurrentPermissionsPort {
  perms: string[] = [
    PermissionCatalog.CLUB_APPOINTMENT_MANAGE,
    PermissionCatalog.CLUB_MEMBER_MANAGE,
  ];
  role = 'club-acm/负责人组';

  async effectiveForClub(): Promise<string[]> {
    return [...this.perms];
  }

  async isPlatformSuperAdmin(): Promise<boolean> {
    return false;
  }

  async primaryRoleAt(): Promise<string> {
    return this.role;
  }
}

function buildHarness() {
  const casdoor = new InMemoryCasdoorPort({
    groups: [
      {
        ref: { owner: 'club-acm', name: 'ACM社团' },
        displayName: 'ACM社团',
        parentRef: null,
        memberIds: ['u_a', 'u_b', 'u_c', 'u_d'],
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
  const apptStore = new InMemoryAppointmentCommandStore();
  const scheduler = new InMemoryJobScheduler();
  const notifications = new InMemoryNotificationPort();
  const permissions = new MutablePermissions();
  const relations = new RelationCommandUseCase(
    relationStore,
    clubs,
    casdoor,
    new InMemoryGroupMappingRegistry(),
    scheduler,
    notifications,
    permissions,
  );
  const useCase = new AppointmentCommandUseCase(
    apptStore,
    clubs,
    permissions,
    relations,
    scheduler,
    notifications,
    casdoor,
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

  return {
    clubs,
    casdoor,
    apptStore,
    relationStore,
    scheduler,
    useCase,
    club,
    permissions,
    relations,
  };
}

describe('AppointmentCommandUseCase', () => {
  let h: ReturnType<typeof buildHarness>;

  beforeEach(async () => {
    h = buildHarness();
    await h.clubs.save(h.club);
  });

  const baseCreate = {
    clubId: 'club-acm-1',
    type: 'appoint' as const,
    content: {
      subjectId: 'u_d',
      departmentGroup: undefined,
      positionGroup: { owner: 'club-acm', name: '宣传部' },
    },
    plannedAt: '2026-08-10T00:00:00.000Z',
    initiator: 'u_b',
    initiatorRoleAtCreate: 'u_b',
    now: new Date('2026-08-01T00:00:00.000Z'),
  };

  it('create：预约新建 → 待执行并登记调度任务（原内容不可改写）', async () => {
    const cmd = await h.useCase.create(baseCreate);
    assert.equal(cmd.status, 'pending_execution');
    assert.equal(cmd.scheduleVersion, 1);
    const tasks = await h.scheduler.listDue(new Date('2026-08-10T00:00:00.000Z'));
    assert.ok(tasks.some((t) => t.kind === 'appointment_due' && t.refId === cmd.id));
    assert.throws(() => {
      (cmd.content as Record<string, unknown>).subjectId = 'hacked';
    }, TypeError);
  });

  it('create：社团未启用 → 拒绝（ORG-001）', async () => {
    h.club.status = 'suspended';
    await h.clubs.save(h.club);
    await assert.rejects(
      () => h.useCase.create(baseCreate),
      (e: Error) => e.message.includes('禁止预约任命'),
    );
  });

  it('create：发起人无预约管理权限 → 拒绝（ORG-039）', async () => {
    h.permissions.perms = [];
    await assert.rejects(
      () => h.useCase.create(baseCreate),
      (e: Error) => e.message.includes('无预约管理权限'),
    );
  });

  it('create：计划时间不晚于当前 → 拒绝', async () => {
    await assert.rejects(
      () =>
        h.useCase.create({
          ...baseCreate,
          plannedAt: '2026-07-01T00:00:00.000Z',
          now: new Date('2026-08-01T00:00:00.000Z'),
        }),
      (e: Error) => e.message.includes('晚于当前时间'),
    );
  });

  it('scheduleExecute：到期正常执行并创建关系命令 → 回读确认后生效', async () => {
    const cmd = await h.useCase.create(baseCreate);
    const executing = await h.useCase.scheduleExecute({
      commandId: cmd.id,
      clubId: cmd.clubId,
      actor: 'system',
      now: new Date('2026-08-10T00:00:20.000Z'),
    });
    assert.equal(executing.status, 'executing');
    const rel = await h.relationStore.findByProcessingForSubject(cmd.clubId, 'u_d');
    assert.ok(rel);
    assert.equal(rel.type, 'appoint_position');

    const effective = await h.useCase.settleExecution({
      commandId: cmd.id,
      success: true,
      reason: 'readback confirmed',
      now: new Date('2026-08-10T00:01:00.000Z'),
    });
    assert.equal(effective.status, 'effective');
    assert.equal(effective.actualEffectiveAt, '2026-08-10T00:01:00.000Z');
  });

  it('scheduleExecute：未到达执行时间 → 前置条件拒绝（而非租约 409）', async () => {
    const cmd = await h.useCase.create(baseCreate);
    await assert.rejects(
      () =>
        h.useCase.scheduleExecute({
          commandId: cmd.id,
          clubId: cmd.clubId,
          actor: 'system',
          now: new Date('2026-08-01T00:00:00.000Z'),
        }),
      (e: Error) => e.message.includes('尚未到达执行时间'),
    );
  });

  it('scheduleExecute：目标主体非社团成员 → 前置条件失效暂停待处置（ORG-039）', async () => {
    const cmd = await h.useCase.create({
      ...baseCreate,
      content: { subjectId: 'not_a_member', positionGroup: { owner: 'club-acm', name: '宣传部' } },
    });
    const paused = await h.useCase.scheduleExecute({
      commandId: cmd.id,
      clubId: cmd.clubId,
      actor: 'system',
      now: new Date('2026-08-10T00:00:20.000Z'),
    });
    assert.equal(paused.status, 'precondition_invalid_pending_resolution');
    assert.ok(
      paused.preconditionSnapshot?.some((p) => p.name === 'subject_member' && p.ok === false),
    );
    assert.equal(
      await h.relationStore.findByProcessingForSubject(cmd.clubId, 'not_a_member'),
      null,
    );
  });

  it('scheduleExecute：发起人已失权 → 暂停待重新确认（不得自动执行）', async () => {
    const cmd = await h.useCase.create(baseCreate);
    h.permissions.perms = [];
    const paused = await h.useCase.scheduleExecute({
      commandId: cmd.id,
      clubId: cmd.clubId,
      actor: 'system',
      now: new Date('2026-08-10T00:00:20.000Z'),
    });
    assert.equal(paused.status, 'initiator_revoked_pending_reconfirm');
    assert.equal(await h.relationStore.findByProcessingForSubject(cmd.clubId, 'u_d'), null);
  });

  it('cancel：待执行可由当前管理员取消（不可恢复终态）', async () => {
    const cmd = await h.useCase.create(baseCreate);
    const cancelled = await h.useCase.cancel({
      commandId: cmd.id,
      clubId: cmd.clubId,
      actor: 'u_b',
      reason: '流程调整',
      now: new Date('2026-08-02T00:00:00.000Z'),
    });
    assert.equal(cancelled.status, 'cancelled');
    assert.equal(cancelled.cancelReason, '流程调整');
    await assert.rejects(
      () =>
        h.useCase.scheduleExecute({
          commandId: cmd.id,
          clubId: cmd.clubId,
          actor: 'system',
          now: new Date('2026-08-10T00:00:20.000Z'),
        }),
      (e: Error) => (e as { code?: string }).code === 'IFC-ERR-007',
    );
  });

  it('关系命令回读确认 → 预约命令自动收口生效（settleExecution 回调链路）', async () => {
    const cmd = await h.useCase.create(baseCreate);
    const executing = await h.useCase.scheduleExecute({
      commandId: cmd.id,
      clubId: cmd.clubId,
      actor: 'system',
      now: new Date('2026-08-10T00:00:20.000Z'),
    });
    assert.equal(executing.status, 'executing');
    const rel = await h.relationStore.findByProcessingForSubject(cmd.clubId, 'u_d');
    assert.ok(rel);

    // 写入目标职位 Group 后回读确认，触发关系命令 → 预约命令收口
    await h.casdoor.writeMembership({
      ref: { owner: 'club-acm', name: '宣传部' },
      subjectId: 'u_d',
      action: 'add',
      requestId: 'req-confirm',
    });
    await h.relations.systemConfirmReadback({
      commandId: rel.id,
      clubId: cmd.clubId,
      now: new Date('2026-08-10T00:01:00.000Z'),
    });

    const settled = await h.apptStore.findById(cmd.id);
    assert.equal(settled?.status, 'effective');
    assert.ok(settled?.actualEffectiveAt);
  });

  it('scheduleExecute：发起人仅具预约管理权限也能驱动关系命令执行（ORG-039 内链路）', async () => {
    // 移除成员管理权限，仅保留预约管理权限：预约执行以内链路提交关系命令，不应被
    // CLUB_MEMBER_MANAGE 权限拒绝。
    h.permissions.perms = [PermissionCatalog.CLUB_APPOINTMENT_MANAGE];
    const cmd = await h.useCase.create({ ...baseCreate, initiator: 'u_personnel' });
    const executing = await h.useCase.scheduleExecute({
      commandId: cmd.id,
      clubId: cmd.clubId,
      actor: 'system',
      now: new Date('2026-08-10T00:00:20.000Z'),
    });
    assert.equal(executing.status, 'executing');
    const rel = await h.relationStore.findByProcessingForSubject(cmd.clubId, 'u_d');
    assert.ok(rel);
  });

  it('scheduleExecute 暂停后释放租约：reconfirm 后仍可重新执行（ORG-039 不阻塞）', async () => {
    const cmd = await h.useCase.create(baseCreate);
    h.permissions.perms = [];
    const paused = await h.useCase.scheduleExecute({
      commandId: cmd.id,
      clubId: cmd.clubId,
      actor: 'system',
      now: new Date('2026-08-10T00:00:20.000Z'),
    });
    assert.equal(paused.status, 'initiator_revoked_pending_reconfirm');

    // 恢复权限并重新确认新执行时间
    h.permissions.perms = [
      PermissionCatalog.CLUB_APPOINTMENT_MANAGE,
      PermissionCatalog.CLUB_MEMBER_MANAGE,
    ];
    const reconfirmed = await h.useCase.reconfirm({
      commandId: cmd.id,
      clubId: cmd.clubId,
      actor: 'u_b',
      newExecTime: '2026-08-11T00:00:00.000Z',
      now: new Date('2026-08-10T01:00:00.000Z'),
    });
    assert.equal(reconfirmed.status, 'reconfirmed_pending_execution');

    // 租约已释放，重新执行不被永久阻塞
    const executing = await h.useCase.scheduleExecute({
      commandId: cmd.id,
      clubId: cmd.clubId,
      actor: 'system',
      now: new Date('2026-08-11T00:00:20.000Z'),
    });
    assert.equal(executing.status, 'executing');
  });

  it('关系命令失败收口 → 释放租约供人工重试（ORG-039 不阻塞）', async () => {
    const cmd = await h.useCase.create(baseCreate);
    await h.useCase.scheduleExecute({
      commandId: cmd.id,
      clubId: cmd.clubId,
      actor: 'system',
      now: new Date('2026-08-10T00:00:20.000Z'),
    });
    const rel = await h.relationStore.findByProcessingForSubject(cmd.clubId, 'u_d');
    assert.ok(rel);

    // 模拟写入已启动且 15 分钟窗口已过，直接调用 handleReadback 触发 final_failure，
    // 进而驱动预约命令收口为待重试。
    await h.relationStore.save({
      ...rel,
      status: 'processing',
      retryDeadline: '2026-08-10T00:00:10.000Z',
    });
    await h.relations.handleReadback(
      { commandId: rel.id, now: new Date('2026-08-10T00:30:00.000Z') },
      { membersByGroup: {} },
    );
    const settled = await h.apptStore.findById(cmd.id);
    assert.equal(settled?.status, 'exec_failed_pending_retry');

    // 失败收口已释放租约：人工重试可重新取得租约（不被 system 租约阻塞）
    const retried = await h.useCase.retryExecute({
      commandId: cmd.id,
      clubId: cmd.clubId,
      actor: 'u_b',
      now: new Date('2026-08-10T00:32:00.000Z'),
    });
    assert.equal(retried.status, 'executing');
  });
});
