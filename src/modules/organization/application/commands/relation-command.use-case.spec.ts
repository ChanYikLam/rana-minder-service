import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { createClubSpace } from '../../domain/models/club-space';
import { PermissionCatalog } from '../../domain/models/permission-template';
import { RelationCommandUseCase } from './relation-command.use-case';
import {
  InMemoryCasdoorPort,
  InMemoryClubStore,
  InMemoryJobScheduler,
  InMemoryNotificationPort,
  InMemoryRelationCommandStore,
} from '../../infrastructure/in-memory/memory-implementations';
import type { CurrentPermissionsPort } from '../ports';

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

function buildHarness() {
  const casdoor = new InMemoryCasdoorPort({
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
  const scheduler = new InMemoryJobScheduler();
  const notifications = new InMemoryNotificationPort();
  const permissions = new MutablePermissions();
  const useCase = new RelationCommandUseCase(
    relationStore,
    clubs,
    casdoor,
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

  return { casdoor, clubs, relationStore, scheduler, useCase, club, permissions };
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

  it('submit：成员前提满足 → 待执行进入处理中并登记执行任务', async () => {
    const cmd = await h.useCase.submit(baseInput, new Date('2026-08-01T00:00:00.000Z'));
    assert.equal(cmd.status, 'processing');
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

  it('handleReadback：全部目标回读确认 → 正式生效并通知', async () => {
    const cmd = await h.useCase.submit(baseInput, new Date('2026-08-01T00:00:00.000Z'));
    // 目标成员已写入宣传部
    await h.casdoor.writeMembership({
      ref: { owner: 'club-acm', name: '宣传部' },
      subjectId: 'u_c',
      action: 'add',
      requestId: 'req-confirm',
    });
    const after = await h.useCase.handleReadback(
      { commandId: cmd.id, now: new Date('2026-08-01T00:00:05.000Z') },
      await h.casdoor.readback([{ owner: 'club-acm', name: '宣传部' }]),
    );
    assert.equal(after.status, 'readback_confirmed');
    assert.ok(after.confirmedAt);
  });

  it('submit：提交者无成员管理权限 → 拒绝（ORG-027）', async () => {
    h.permissions.perms.set('club-acm-1', []);
    await assert.rejects(
      () => h.useCase.submit(baseInput, new Date('2026-08-01T00:00:00.000Z')),
      (e: Error) => e.message.includes('无成员关系管理权限'),
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
});
