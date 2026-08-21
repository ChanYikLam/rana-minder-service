/**
 * 站内信呈现状态命令测试（NTF-003：已读/已处理/隐藏、全部已读）。
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import type { NotificationRepository } from '../../infrastructure';
import { InMemoryInboxAdapter, InMemoryNotificationRepository } from '../../infrastructure';
import { MarkPresentationStatusCommand } from './mark-presentation-status.command';
import { MarkAllReadCommand } from './mark-all-read.command';
import { DeliverInboxCommand } from './deliver-inbox.command';
import type { CreateNotificationFactInput, RecipientSnapshot } from '../../domain';

describe('MarkPresentationStatusCommand（NTF-003）', () => {
  let repo: NotificationRepository;
  let inbox: InMemoryInboxAdapter;
  let deliver: DeliverInboxCommand;
  let command: MarkPresentationStatusCommand;
  let seq = 0;

  beforeEach(() => {
    seq += 1;
    repo = new InMemoryNotificationRepository();
    inbox = new InMemoryInboxAdapter();
    deliver = new DeliverInboxCommand(repo, inbox);
    command = new MarkPresentationStatusCommand(inbox, repo);
  });

  /** 创建一条事实并为 stu-1 投递出呈现 */
  async function deliverToUser(recipientId: string, eventType = 'conclusion') {
    const input: CreateNotificationFactInput = {
      logicalEventId: `logical-${seq}-${recipientId}`,
      sourceObjectId: `src-${seq}`,
      sourceObjectVersion: 1,
      sourceCommandId: `cmd-${seq}`,
      eventType: eventType as CreateNotificationFactInput['eventType'],
      eventTime: '2026-09-08T00:00:00.000Z',
      summary: `结论通知 ${seq}`,
      targetObjectRef: `/me/conclusion/${seq}`,
      scope: { type: 'CLUB', clubId: 'club-1' },
    };
    const snapshot: RecipientSnapshot = {
      snapshotId: '',
      factId: '',
      recipientId,
      reason: '本人',
      scope: { type: 'CLUB', clubId: 'club-1' },
      dedupKey: `logical-${seq}-${recipientId}`,
      createdAt: '',
    };
    const saved = await repo.saveFactWithSnapshots(input, [snapshot]);
    await deliver.execute(saved.fact.factId, saved.fact.version);
    const presentations = await inbox.listForUser(recipientId, {}, null, 100);
    assert.equal(presentations.length, 1);
    return presentations[0];
  }

  it('未读 → 已读（readAt 记录）', async () => {
    const pres = await deliverToUser('stu-1');
    const result = await command.execute(pres.presentationId, 'stu-1', 'READ');
    assert.equal(result.status, 'READ');
    const updated = await inbox.findPresentation(pres.presentationId);
    assert.ok(updated?.readAt);
    assert.equal(updated.status, 'READ');
  });

  it('未读 → 已处理', async () => {
    const pres = await deliverToUser('stu-1');
    const result = await command.execute(pres.presentationId, 'stu-1', 'PROCESSED');
    assert.equal(result.status, 'PROCESSED');
    const updated = await inbox.findPresentation(pres.presentationId);
    assert.ok(updated?.processedAt);
  });

  it('未读 → 隐藏（权益通知不可物理删除，归入隐藏列表）', async () => {
    const pres = await deliverToUser('stu-1');
    const result = await command.execute(pres.presentationId, 'stu-1', 'HIDDEN');
    assert.equal(result.status, 'HIDDEN');
    const updated = await inbox.findPresentation(pres.presentationId);
    assert.ok(updated?.hiddenAt);
  });

  it('已处理为终态，不可逆回已读', async () => {
    const pres = await deliverToUser('stu-1');
    await command.execute(pres.presentationId, 'stu-1', 'PROCESSED');
    await assert.rejects(command.execute(pres.presentationId, 'stu-1', 'READ'), /不可逆回/);
  });

  it('已隐藏为终态，不可逆回', async () => {
    const pres = await deliverToUser('stu-1');
    await command.execute(pres.presentationId, 'stu-1', 'HIDDEN');
    await assert.rejects(command.execute(pres.presentationId, 'stu-1', 'PROCESSED'), /不可逆回/);
  });

  it('非本人操作视为不存在（不泄露他人通知）', async () => {
    const pres = await deliverToUser('stu-1');
    await assert.rejects(command.execute(pres.presentationId, 'stu-2', 'READ'), /不存在/);
  });

  it('已处理可重复标记（幂等）', async () => {
    const pres = await deliverToUser('stu-1');
    await command.execute(pres.presentationId, 'stu-1', 'PROCESSED');
    const second = await command.execute(pres.presentationId, 'stu-1', 'PROCESSED');
    assert.equal(second.status, 'PROCESSED');
  });
});

describe('MarkAllReadCommand（NTF-003：全部标记已读）', () => {
  let repo: NotificationRepository;
  let inbox: InMemoryInboxAdapter;
  let deliver: DeliverInboxCommand;
  let allRead: MarkAllReadCommand;
  let seq = 0;
  let deliverSeq = 0;

  beforeEach(() => {
    seq += 1;
    repo = new InMemoryNotificationRepository();
    inbox = new InMemoryInboxAdapter();
    deliver = new DeliverInboxCommand(repo, inbox);
    allRead = new MarkAllReadCommand(inbox);
  });

  async function deliverToUser(recipientId: string) {
    const n = deliverSeq++;
    const input: CreateNotificationFactInput = {
      // 每次投递唯一逻辑事件（NTF-003：同一逻辑事件＋收件人只允许一条）
      logicalEventId: `logical-all-${seq}-${recipientId}-${n}`,
      sourceObjectId: `src-${seq}-${n}`,
      sourceObjectVersion: 1,
      sourceCommandId: `cmd-${seq}-${n}`,
      eventType: 'interview',
      eventTime: '2026-09-08T00:00:00.000Z',
      summary: `面试通知 ${seq}`,
      targetObjectRef: '/me/interviews/1',
      scope: { type: 'PLATFORM', clubId: null },
    };
    const snapshot: RecipientSnapshot = {
      snapshotId: '',
      factId: '',
      recipientId,
      reason: '本人',
      scope: { type: 'PLATFORM', clubId: null },
      dedupKey: `logical-all-${seq}-${recipientId}-${n}`,
      createdAt: '',
    };
    const saved = await repo.saveFactWithSnapshots(input, [snapshot]);
    await deliver.execute(saved.fact.factId, saved.fact.version);
  }

  it('全部未读 → 全部已读，未读数归零', async () => {
    await deliverToUser('stu-1');
    await deliverToUser('stu-1');
    assert.equal(await inbox.countUnread('stu-1'), 2);

    const result = await allRead.execute('stu-1');
    assert.equal(result.updatedCount, 2);
    assert.equal(await inbox.countUnread('stu-1'), 0);
  });

  it('只影响本人，不影响其他收件人', async () => {
    await deliverToUser('stu-1');
    await deliverToUser('stu-2');
    await allRead.execute('stu-1');
    assert.equal(await inbox.countUnread('stu-1'), 0);
    assert.equal(await inbox.countUnread('stu-2'), 1);
  });

  it('已处理/已隐藏不受全部已读影响', async () => {
    await deliverToUser('stu-1');
    const [pres] = await inbox.listForUser('stu-1', {}, null, 100);
    await inbox.updatePresentationStatus(pres.presentationId, 'PROCESSED', pres.version);
    await allRead.execute('stu-1');
    const updated = await inbox.findPresentation(pres.presentationId);
    assert.equal(updated?.status, 'PROCESSED');
  });
});
