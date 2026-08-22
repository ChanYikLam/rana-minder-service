/**
 * 站内信紧急关闭/恢复命令测试（NTF-001、SRS-FAIL-009、IFC-NTF-001、XCC-FAIL-009）。
 *
 * 覆盖：关闭校验（原因/二次确认/预计恢复时间/特权审计）、关闭暂停投递且
 * 事实与快照保留、范围隔离、幂等关闭、恢复按原事件时间升序补投、逻辑事件
 * ＋收件人去重、只补投渠道不重放业务。
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import type {
  InboxAdapter,
  InboxListFilter,
  KillSwitchRepository,
  NotificationRepository,
} from '../../infrastructure';
import {
  InMemoryInboxAdapter,
  InMemoryKillSwitchRepository,
  InMemoryNotificationRepository,
  InMemoryPrivilegedAuditWriter,
} from '../../infrastructure';
import { ApplyKillSwitchCommand } from './apply-kill-switch.command';
import { ResumeKillSwitchCommand } from './resume-kill-switch.command';
import { CreateNotificationFactCommand } from './create-notification-fact.command';
import type {
  CreateNotificationFactInput,
  InboxPresentationModel,
  InboxPresentationStatus,
  RecipientSnapshot,
} from '../../domain';
import type { NotificationFactModel } from '../../domain';

/** 记录补投顺序的站内信适配器（用于断言 IFC-NTF-001 原事件时间升序） */
class RecordingInboxAdapter implements InboxAdapter {
  readonly createdOrder: string[] = [];
  constructor(private readonly inner: InboxAdapter) {}
  async createOrConfirmPresentation(fact: NotificationFactModel, snapshot: RecipientSnapshot) {
    this.createdOrder.push(fact.factId);
    return this.inner.createOrConfirmPresentation(fact, snapshot);
  }
  async updatePresentationStatus(
    presentationId: string,
    status: InboxPresentationStatus,
    expectedVersion: number,
  ): Promise<InboxPresentationModel> {
    return this.inner.updatePresentationStatus(presentationId, status, expectedVersion);
  }
  async markAllRead(recipientId: string): Promise<number> {
    return this.inner.markAllRead(recipientId);
  }
  async listForUser(
    recipientId: string,
    filter: InboxListFilter,
    cursor: string | null,
    limit: number,
  ) {
    return this.inner.listForUser(recipientId, filter, cursor, limit);
  }
  async countUnread(recipientId: string): Promise<number> {
    return this.inner.countUnread(recipientId);
  }
  async findPresentation(presentationId: string) {
    return this.inner.findPresentation(presentationId);
  }
}

describe('ApplyKillSwitchCommand（SRS-FAIL-009：紧急关闭）', () => {
  let repo: NotificationRepository;
  let killSwitches: KillSwitchRepository;
  let audit: InMemoryPrivilegedAuditWriter;
  let command: ApplyKillSwitchCommand;
  let seq = 0;

  const NOW = '2026-09-10T00:00:00.000Z';
  const FUTURE = '2026-09-20T00:00:00.000Z';

  beforeEach(() => {
    seq += 1;
    repo = new InMemoryNotificationRepository();
    killSwitches = new InMemoryKillSwitchRepository();
    audit = new InMemoryPrivilegedAuditWriter();
    command = new ApplyKillSwitchCommand(repo, killSwitches, audit);
  });

  /** 在指定社团创建一条待投递通知事实 */
  async function createPendingFact(clubId: string | null, eventTime: string, recipientId: string) {
    const input: CreateNotificationFactInput = {
      logicalEventId: `logical-${clubId}-${eventTime}-${seq}`,
      sourceObjectId: `src-${seq}`,
      sourceObjectVersion: 1,
      sourceCommandId: `cmd-${seq}`,
      eventType: 'conclusion',
      eventTime,
      summary: `结论通知 ${seq}`,
      targetObjectRef: `/me/conclusion/${seq}`,
      scope: { type: clubId ? 'CLUB' : 'PLATFORM', clubId },
    };
    const snapshot: RecipientSnapshot = {
      snapshotId: '',
      factId: '',
      recipientId,
      reason: '本人',
      scope: { type: clubId ? 'CLUB' : 'PLATFORM', clubId },
      dedupKey: `logical-${clubId}-${eventTime}-${seq}\u0000${recipientId}`,
      createdAt: '',
    };
    const result = await repo.saveFactWithSnapshots(input, [snapshot]);
    return result.fact;
  }

  it('缺少原因 → 拒绝关闭', async () => {
    await assert.rejects(
      command.execute(
        {
          scope: 'CLUB',
          clubId: 'club-1',
          reason: '',
          operatorId: 'admin-1',
          operatorName: '超管',
          expectedRecoveryAt: FUTURE,
          confirmed: true,
        },
        NOW,
      ),
      /原因/,
    );
  });

  it('未二次确认 → 拒绝关闭', async () => {
    await assert.rejects(
      command.execute(
        {
          scope: 'CLUB',
          clubId: 'club-1',
          reason: '平台维护',
          operatorId: 'admin-1',
          operatorName: '超管',
          expectedRecoveryAt: FUTURE,
          confirmed: false,
        },
        NOW,
      ),
      /二次确认/,
    );
  });

  it('未设置预计恢复时间 → 拒绝关闭', async () => {
    await assert.rejects(
      command.execute(
        {
          scope: 'CLUB',
          clubId: 'club-1',
          reason: '平台维护',
          operatorId: 'admin-1',
          operatorName: '超管',
          expectedRecoveryAt: null,
          confirmed: true,
        },
        NOW,
      ),
      /预计恢复时间/,
    );
  });

  it('关闭暂停范围内待投递事实，通知事实与快照仍保留（SRS-FAIL-009）', async () => {
    const fact = await createPendingFact('club-1', '2026-09-08T00:00:00.000Z', 'stu-1');
    const result = await command.execute(
      {
        scope: 'CLUB',
        clubId: 'club-1',
        reason: '系统维护',
        operatorId: 'admin-1',
        operatorName: '超管甲',
        expectedRecoveryAt: FUTURE,
        confirmed: true,
      },
      NOW,
    );

    assert.equal(result.pausedFactCount, 1);
    const stored = await repo.findFactById(fact.factId);
    assert.ok(stored, '通知事实必须保留');
    assert.equal(stored.status, 'CREATED_PAUSED_DELIVERY');
    const snapshots = await repo.findSnapshotsByFactId(fact.factId);
    assert.equal(snapshots.length, 1, '收件人快照必须保留');
    assert.equal(snapshots[0].recipientId, 'stu-1');
  });

  it('平台范围关闭覆盖全部社团，社团范围只覆盖本社团（范围隔离）', async () => {
    const factA = await createPendingFact('club-1', '2026-09-08T00:00:00.000Z', 'stu-1');
    const factB = await createPendingFact('club-2', '2026-09-08T00:00:00.000Z', 'stu-2');

    // 先社团级关闭 club-1
    await command.execute(
      {
        scope: 'CLUB',
        clubId: 'club-1',
        reason: '维护',
        operatorId: 'admin-1',
        operatorName: '超管',
        expectedRecoveryAt: FUTURE,
        confirmed: true,
      },
      NOW,
    );
    assert.equal((await repo.findFactById(factA.factId))?.status, 'CREATED_PAUSED_DELIVERY');
    assert.equal((await repo.findFactById(factB.factId))?.status, 'CREATED_PENDING_DELIVERY');

    // 平台级关闭覆盖 club-2（club-1 已暂停，保持暂停）
    await command.execute(
      {
        scope: 'PLATFORM',
        clubId: null,
        reason: '平台紧急维护',
        operatorId: 'admin-1',
        operatorName: '超管',
        expectedRecoveryAt: FUTURE,
        confirmed: true,
      },
      NOW,
    );
    assert.equal((await repo.findFactById(factB.factId))?.status, 'CREATED_PAUSED_DELIVERY');
    assert.equal((await repo.findFactById(factA.factId))?.status, 'CREATED_PAUSED_DELIVERY');
  });

  it('重复关闭同范围幂等：保留首次 stoppedAt，不重复暂停', async () => {
    await createPendingFact('club-1', '2026-09-08T00:00:00.000Z', 'stu-1');
    const first = await command.execute(
      {
        scope: 'CLUB',
        clubId: 'club-1',
        reason: '维护',
        operatorId: 'admin-1',
        operatorName: '超管',
        expectedRecoveryAt: FUTURE,
        confirmed: true,
      },
      NOW,
    );
    const second = await command.execute(
      {
        scope: 'CLUB',
        clubId: 'club-1',
        reason: '维护',
        operatorId: 'admin-1',
        operatorName: '超管',
        expectedRecoveryAt: FUTURE,
        confirmed: true,
      },
      '2026-09-11T00:00:00.000Z',
    );

    assert.equal(second.state.stoppedAt, first.state.stoppedAt);
    assert.equal(second.pausedFactCount, 0);
    const state = await killSwitches.findByScope('CLUB', 'club-1');
    assert.equal(state?.active, true);
  });

  it('关闭写入特权审计（原因/操作者/预计恢复时间）', async () => {
    await createPendingFact('club-1', '2026-09-08T00:00:00.000Z', 'stu-1');
    await command.execute(
      {
        scope: 'CLUB',
        clubId: 'club-1',
        reason: '数据迁移',
        operatorId: 'admin-9',
        operatorName: '超管乙',
        expectedRecoveryAt: FUTURE,
        confirmed: true,
      },
      NOW,
    );

    const entries = audit.list();
    const apply = entries.find((e) => e.action === 'notification.kill_switch.apply');
    assert.ok(apply, '必须写入特权审计');
    assert.equal(apply.actorId, 'admin-9');
    assert.equal(apply.reason, '数据迁移');
    assert.equal(apply.scope, 'club:club-1');
    assert.equal(apply.detail.expectedRecoveryAt, FUTURE);
  });

  it('关闭期间新通知事实进入暂停投递（CREATE 转换 1 与 KILL 转换 2 联动）', async () => {
    await command.execute(
      {
        scope: 'PLATFORM',
        clubId: null,
        reason: '紧急维护',
        operatorId: 'admin-1',
        operatorName: '超管',
        expectedRecoveryAt: FUTURE,
        confirmed: true,
      },
      NOW,
    );

    // 关闭期间经 CreateNotificationFactCommand 创建的事实标记为暂停投递
    const createCommand = new CreateNotificationFactCommand(
      repo,
      { resolve: () => ({ recipients: [], resolutionRationale: '' }) },
      killSwitches,
    );
    const result = await createCommand.execute({
      logicalEventId: `logical-new-${seq}`,
      sourceObjectId: `src-new-${seq}`,
      sourceObjectVersion: 1,
      sourceCommandId: `cmd-new-${seq}`,
      eventType: 'conclusion',
      eventTime: '2026-09-09T00:00:00.000Z',
      summary: '关闭期间新结论通知',
      targetObjectRef: null,
      scope: { type: 'CLUB', clubId: 'club-5' },
    });
    const fact = await repo.findFactById(result.factId);
    assert.ok(fact, '关闭期间通知事实仍必须保存');
    assert.equal(fact.status, 'CREATED_PAUSED_DELIVERY');
  });

  it('批量暂停无进展时终止循环，不死循环（评审 #5）', async () => {
    // 模拟查询集里出现不满足 KILL_INBOX 转换的事实（如已投递），
    // 且该事实永远无法移出查询集；无进度保护会死循环
    const stuckRepo = new InMemoryNotificationRepository();
    const input: CreateNotificationFactInput = {
      logicalEventId: `logical-stuck-${seq}`,
      sourceObjectId: `src-stuck-${seq}`,
      sourceObjectVersion: 1,
      sourceCommandId: `cmd-stuck-${seq}`,
      eventType: 'conclusion',
      eventTime: '2026-09-08T00:00:00.000Z',
      summary: '无法转换的事实',
      targetObjectRef: null,
      scope: { type: 'CLUB', clubId: 'club-1' },
    };
    const snapshot = {
      snapshotId: '',
      factId: '',
      recipientId: 'stu-1',
      reason: '本人',
      scope: { type: 'CLUB' as const, clubId: 'club-1' },
      dedupKey: `logical-stuck-${seq}`,
      createdAt: '',
    };
    const saved = await stuckRepo.saveFactWithSnapshots(input, [snapshot]);
    // 把该事实直接置为已投递（KILL_INBOX 拒绝），并让查询恒返回它
    await stuckRepo.updateFactStatus(saved.fact.factId, 'DELIVERED', saved.fact.version);
    (
      stuckRepo as unknown as {
        findFactsPendingDeliveryByKillScope: () => Promise<unknown>;
      }
    ).findFactsPendingDeliveryByKillScope = async () => {
      const fact = await stuckRepo.findFactById(saved.fact.factId);
      return fact ? [fact] : [];
    };

    const stuckCommand = new ApplyKillSwitchCommand(
      stuckRepo,
      killSwitches,
      new InMemoryPrivilegedAuditWriter(),
    );
    const result = await stuckCommand.execute(
      {
        scope: 'CLUB',
        clubId: 'club-1',
        reason: '维护',
        operatorId: 'admin-1',
        operatorName: '超管',
        expectedRecoveryAt: FUTURE,
        confirmed: true,
      },
      NOW,
    );
    // 能正常返回即证明未死循环；不满足转换因此暂停数为 0
    assert.equal(result.pausedFactCount, 0);
  });
});

describe('ResumeKillSwitchCommand（IFC-NTF-001：恢复补投）', () => {
  let repo: NotificationRepository;
  let killSwitches: KillSwitchRepository;
  let audit: InMemoryPrivilegedAuditWriter;
  let innerInbox: InMemoryInboxAdapter;
  let inbox: RecordingInboxAdapter;
  let apply: ApplyKillSwitchCommand;
  let resume: ResumeKillSwitchCommand;
  let seq = 0;

  const NOW = '2026-09-10T00:00:00.000Z';
  const FUTURE = '2026-09-20T00:00:00.000Z';

  beforeEach(() => {
    seq += 1;
    repo = new InMemoryNotificationRepository();
    killSwitches = new InMemoryKillSwitchRepository();
    audit = new InMemoryPrivilegedAuditWriter();
    innerInbox = new InMemoryInboxAdapter();
    inbox = new RecordingInboxAdapter(innerInbox);
    apply = new ApplyKillSwitchCommand(repo, killSwitches, audit);
    resume = new ResumeKillSwitchCommand(repo, killSwitches, inbox, audit);
  });

  async function createPendingFact(
    clubId: string | null,
    eventTime: string,
    recipientId: string,
    initialStatus:
      'CREATED_PENDING_DELIVERY' | 'CREATED_PAUSED_DELIVERY' = 'CREATED_PENDING_DELIVERY',
  ) {
    const input: CreateNotificationFactInput = {
      logicalEventId: `logical-${clubId}-${eventTime}-${seq}`,
      sourceObjectId: `src-${seq}`,
      sourceObjectVersion: 1,
      sourceCommandId: `cmd-${seq}`,
      eventType: 'invitation',
      eventTime,
      summary: `邀请通知 ${seq}`,
      targetObjectRef: `/me/invitations/${seq}`,
      deadlineAt: '2026-09-25T00:00:00.000Z',
      initialStatus,
      scope: { type: clubId ? 'CLUB' : 'PLATFORM', clubId },
    };
    const snapshot: RecipientSnapshot = {
      snapshotId: '',
      factId: '',
      recipientId,
      reason: '本人',
      scope: { type: clubId ? 'CLUB' : 'PLATFORM', clubId },
      dedupKey: `logical-${clubId}-${eventTime}-${seq}\u0000${recipientId}`,
      createdAt: '',
    };
    const result = await repo.saveFactWithSnapshots(input, [snapshot]);
    return result.fact;
  }

  async function closeClub(clubId: string) {
    return apply.execute(
      {
        scope: 'CLUB',
        clubId,
        reason: '维护',
        operatorId: 'admin-1',
        operatorName: '超管',
        expectedRecoveryAt: FUTURE,
        confirmed: true,
      },
      NOW,
    );
  }

  it('没有活跃关闭 → 拒绝恢复', async () => {
    await assert.rejects(
      resume.execute(
        { scope: 'CLUB', clubId: 'club-1', operatorId: 'admin-1', operatorName: '超管' },
        NOW,
      ),
      /没有活跃/,
    );
  });

  it('恢复后按原事件时间升序补投（IFC-NTF-001）', async () => {
    await closeClub('club-1');
    // 关闭期间创建的事实标记为暂停投递（SRS-FAIL-009）
    const late = await createPendingFact(
      'club-1',
      '2026-09-09T00:00:00.000Z',
      'stu-1',
      'CREATED_PAUSED_DELIVERY',
    );
    const early = await createPendingFact(
      'club-1',
      '2026-09-07T00:00:00.000Z',
      'stu-1',
      'CREATED_PAUSED_DELIVERY',
    );
    const middle = await createPendingFact(
      'club-1',
      '2026-09-08T00:00:00.000Z',
      'stu-1',
      'CREATED_PAUSED_DELIVERY',
    );
    assert.equal((await repo.findFactById(early.factId))?.status, 'CREATED_PAUSED_DELIVERY');

    const result = await resume.execute(
      { scope: 'CLUB', clubId: 'club-1', operatorId: 'admin-1', operatorName: '超管' },
      '2026-09-10T02:00:00.000Z',
    );

    assert.equal(result.resumedFactCount, 3);
    assert.deepEqual(inbox.createdOrder, [early.factId, middle.factId, late.factId]);
    for (const fact of [early, middle, late]) {
      assert.equal((await repo.findFactById(fact.factId))?.status, 'DELIVERED');
    }
  });

  it('同一逻辑事件＋收件人只对应一条站内信（NTF-003 去重，重复恢复不重复呈现）', async () => {
    await closeClub('club-1');
    const fact = await createPendingFact(
      'club-1',
      '2026-09-08T00:00:00.000Z',
      'stu-1',
      'CREATED_PAUSED_DELIVERY',
    );

    await resume.execute(
      { scope: 'CLUB', clubId: 'club-1', operatorId: 'admin-1', operatorName: '超管' },
      '2026-09-10T02:00:00.000Z',
    );
    let items = await innerInbox.listForUser('stu-1', {}, null, 100);
    assert.equal(items.filter((p) => p.factId === fact.factId).length, 1);

    // 再次关闭并恢复：补投按逻辑事件＋收件人去重，不重复呈现
    await apply.execute(
      {
        scope: 'CLUB',
        clubId: 'club-1',
        reason: '维护',
        operatorId: 'admin-1',
        operatorName: '超管',
        expectedRecoveryAt: FUTURE,
        confirmed: true,
      },
      '2026-09-11T00:00:00.000Z',
    );
    await apply.execute(
      {
        scope: 'CLUB',
        clubId: 'club-1',
        reason: '维护',
        operatorId: 'admin-1',
        operatorName: '超管',
        expectedRecoveryAt: FUTURE,
        confirmed: true,
      },
      '2026-09-11T01:00:00.000Z',
    );
    await resume.execute(
      { scope: 'CLUB', clubId: 'club-1', operatorId: 'admin-1', operatorName: '超管' },
      '2026-09-11T02:00:00.000Z',
    );

    items = await innerInbox.listForUser('stu-1', {}, null, 100);
    assert.equal(
      items.filter((p) => p.factId === fact.factId).length,
      1,
      '同一事实＋收件人只允许一条站内信',
    );
  });

  it('恢复只补投渠道，不重复执行业务（NTF-001）', async () => {
    await closeClub('club-1');
    const fact = await createPendingFact(
      'club-1',
      '2026-09-08T00:00:00.000Z',
      'stu-1',
      'CREATED_PAUSED_DELIVERY',
    );

    const result = await resume.execute(
      { scope: 'CLUB', clubId: 'club-1', operatorId: 'admin-1', operatorName: '超管' },
      '2026-09-10T02:00:00.000Z',
    );

    // 只创建了呈现（渠道），通知事实未被删除/改写，业务对象引用不变
    assert.equal(result.resumedFactCount, 1);
    const stored = await repo.findFactById(fact.factId);
    assert.ok(stored);
    assert.equal(stored.sourceObjectId, `src-${seq}`);
    assert.equal(inbox.createdOrder.length, 1);
  });

  it('范围隔离：只恢复被关闭范围，其他社团仍暂停', async () => {
    await closeClub('club-1');
    const factA = await createPendingFact(
      'club-1',
      '2026-09-08T00:00:00.000Z',
      'stu-1',
      'CREATED_PAUSED_DELIVERY',
    );
    const factB = await createPendingFact(
      'club-2',
      '2026-09-08T00:00:00.000Z',
      'stu-2',
      'CREATED_PAUSED_DELIVERY',
    );
    await apply.execute(
      {
        scope: 'CLUB',
        clubId: 'club-2',
        reason: '维护',
        operatorId: 'admin-1',
        operatorName: '超管',
        expectedRecoveryAt: FUTURE,
        confirmed: true,
      },
      '2026-09-10T01:00:00.000Z',
    );

    await resume.execute(
      { scope: 'CLUB', clubId: 'club-1', operatorId: 'admin-1', operatorName: '超管' },
      '2026-09-10T02:00:00.000Z',
    );

    assert.equal((await repo.findFactById(factA.factId))?.status, 'DELIVERED');
    assert.equal((await repo.findFactById(factB.factId))?.status, 'CREATED_PAUSED_DELIVERY');
  });

  it('恢复写入特权审计并保留关闭历史（active=false，stoppedAt 不变）', async () => {
    await closeClub('club-1');
    await createPendingFact(
      'club-1',
      '2026-09-08T00:00:00.000Z',
      'stu-1',
      'CREATED_PAUSED_DELIVERY',
    );
    const result = await resume.execute(
      { scope: 'CLUB', clubId: 'club-1', operatorId: 'admin-1', operatorName: '超管' },
      '2026-09-10T02:00:00.000Z',
    );

    assert.equal(result.state.active, false);
    assert.equal(result.state.stoppedAt, NOW);
    const entries = audit.list();
    assert.ok(entries.some((e) => e.action === 'notification.kill_switch.resume'));
  });

  it('超过预计恢复时间仍未恢复时状态仍可查询（恢复提醒依据）', async () => {
    await closeClub('club-1');
    const state = await killSwitches.findByScope('CLUB', 'club-1');
    assert.ok(state);
    assert.equal(state.active, true);
    // 查询服务可读出 expectedRecoveryAt，供超管提醒使用
    assert.equal(state.expectedRecoveryAt, FUTURE);
  });

  it('批量补投无进展时终止循环，不死循环（评审 #5 恢复侧）', async () => {
    // 关闭 club-1；查询集里出现不满足 RESUME_INBOX 的事实（如已投递），
    // 且永远无法移出查询集；无进度保护会死循环
    await apply.execute(
      {
        scope: 'CLUB',
        clubId: 'club-1',
        reason: '维护',
        operatorId: 'admin-1',
        operatorName: '超管',
        expectedRecoveryAt: FUTURE,
        confirmed: true,
      },
      NOW,
    );
    const stuckRepo = new InMemoryNotificationRepository();
    const input: CreateNotificationFactInput = {
      logicalEventId: `logical-stuck-resume-${seq}`,
      sourceObjectId: `src-stuck-r-${seq}`,
      sourceObjectVersion: 1,
      sourceCommandId: `cmd-stuck-r-${seq}`,
      eventType: 'conclusion',
      eventTime: '2026-09-08T00:00:00.000Z',
      summary: '恢复期无法转换的事实',
      targetObjectRef: null,
      scope: { type: 'CLUB', clubId: 'club-1' },
    };
    const snapshot = {
      snapshotId: '',
      factId: '',
      recipientId: 'stu-1',
      reason: '本人',
      scope: { type: 'CLUB' as const, clubId: 'club-1' },
      dedupKey: `logical-stuck-resume-${seq}`,
      createdAt: '',
    };
    const saved = await stuckRepo.saveFactWithSnapshots(input, [snapshot]);
    await stuckRepo.updateFactStatus(saved.fact.factId, 'DELIVERED', saved.fact.version);
    (
      stuckRepo as unknown as {
        findFactsPausedByKillScope: () => Promise<unknown>;
      }
    ).findFactsPausedByKillScope = async () => {
      const fact = await stuckRepo.findFactById(saved.fact.factId);
      return fact ? [fact] : [];
    };

    const stuckResume = new ResumeKillSwitchCommand(stuckRepo, killSwitches, inbox, audit);
    const result = await stuckResume.execute(
      { scope: 'CLUB', clubId: 'club-1', operatorId: 'admin-1', operatorName: '超管' },
      '2026-09-10T02:00:00.000Z',
    );
    // 能正常返回即证明未死循环；不满足转换因此补投数为 0
    assert.equal(result.resumedFactCount, 0);
  });

  it('范围叠加：平台级仍关闭时，恢复社团级不补投该社团暂停事实', async () => {
    // 平台级关闭覆盖全部社团，社团 club-1 的暂停事实须保持暂停
    await apply.execute(
      {
        scope: 'PLATFORM',
        clubId: null,
        reason: '平台紧急维护',
        operatorId: 'admin-1',
        operatorName: '超管',
        expectedRecoveryAt: FUTURE,
        confirmed: true,
      },
      NOW,
    );
    const factA = await createPendingFact(
      'club-1',
      '2026-09-08T00:00:00.000Z',
      'stu-1',
      'CREATED_PAUSED_DELIVERY',
    );
    // 社团级单独关闭（与平台级叠加）
    await closeClub('club-1');

    // 恢复社团级：平台级仍 active，club-1 的暂停事实不得被补投
    const result = await resume.execute(
      { scope: 'CLUB', clubId: 'club-1', operatorId: 'admin-1', operatorName: '超管' },
      '2026-09-10T02:00:00.000Z',
    );
    assert.equal(result.resumedFactCount, 0, '平台级仍关闭时社团级恢复不得补投');
    assert.equal(
      (await repo.findFactById(factA.factId))?.status,
      'CREATED_PAUSED_DELIVERY',
      '事实须保持暂停（平台级关闭覆盖）',
    );
    // 社团级关闭状态被解除，但平台级仍 active
    assert.equal((await killSwitches.findByScope('CLUB', 'club-1'))?.active, false);
    assert.equal((await killSwitches.findByScope('PLATFORM', null))?.active, true);
  });

  it('范围叠加：平台级关闭解除后，暂停事实由平台级恢复统一补投', async () => {
    await apply.execute(
      {
        scope: 'PLATFORM',
        clubId: null,
        reason: '平台紧急维护',
        operatorId: 'admin-1',
        operatorName: '超管',
        expectedRecoveryAt: FUTURE,
        confirmed: true,
      },
      NOW,
    );
    const factA = await createPendingFact(
      'club-1',
      '2026-09-08T00:00:00.000Z',
      'stu-1',
      'CREATED_PAUSED_DELIVERY',
    );
    await closeClub('club-1');

    // 恢复平台级关闭：负责补投全部（含 club-1）暂停事实
    const platformResume = await resume.execute(
      { scope: 'PLATFORM', clubId: null, operatorId: 'admin-1', operatorName: '超管' },
      '2026-09-10T01:00:00.000Z',
    );
    assert.equal(platformResume.resumedFactCount, 1);
    assert.equal((await repo.findFactById(factA.factId))?.status, 'DELIVERED');

    // 平台级恢复已把 club-1 事实补投，club-1 单独恢复无待投事实（幂等）
    const clubResume = await resume.execute(
      { scope: 'CLUB', clubId: 'club-1', operatorId: 'admin-1', operatorName: '超管' },
      '2026-09-10T02:00:00.000Z',
    );
    assert.equal(clubResume.resumedFactCount, 0);
    assert.equal((await repo.findFactById(factA.factId))?.status, 'DELIVERED');
  });
});
