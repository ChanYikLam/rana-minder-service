import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { createClubSpace } from '../../domain/models/club-space';
import { AppointmentCommandUseCase } from './appointment-command.use-case';
import { RelationCommandUseCase } from './relation-command.use-case';
import {
  InMemoryAppointmentCommandStore,
  InMemoryCasdoorPort,
  InMemoryClubStore,
  InMemoryJobScheduler,
  InMemoryNotificationPort,
  InMemoryRelationCommandStore,
} from '../../infrastructure/in-memory/memory-implementations';
import type { CurrentPermissionsPort } from '../ports';

class MutablePermissions implements CurrentPermissionsPort {
  perms: string[] = ['club:appointment:manage', 'club:member:manage'];

  async effectiveForClub(): Promise<string[]> {
    return [...this.perms];
  }

  async isPlatformSuperAdmin(): Promise<boolean> {
    return false;
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

  return { clubs, casdoor, apptStore, relationStore, scheduler, useCase, club, permissions };
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

  it('scheduleExecute：目标主体非社团成员 → 前置条件失效暂停待处置（ORG-039）', async () => {
    const cmd = await h.useCase.create({
      ...baseCreate,
      content: { subjectId: 'not_a_member', positionGroup: { owner: 'club-acm', name: '宣传部' } },
    });
    const paused = await h.useCase.scheduleExecute({
      commandId: cmd.id,
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
          actor: 'system',
          now: new Date('2026-08-10T00:00:20.000Z'),
        }),
      (e: Error) => (e as { code?: string }).code === 'IFC-ERR-007',
    );
  });
});
