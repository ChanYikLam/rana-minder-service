/**
 * 通知查询服务测试（NTF-003：类型筛选、未读筛选、隐藏列表、
 * 有期限通知当前办理状态展示）。
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { InMemoryInboxAdapter, InMemoryNotificationRepository, InMemoryChannelDeliveryAttemptRepository } from '../../infrastructure';
import { NotificationQueryService } from './notification-query.service';
import { DeliverInboxCommand } from '../commands/deliver-inbox.command';
import type { CreateNotificationFactInput, RecipientSnapshot } from '../../domain';

describe('NotificationQueryService（NTF-003）', () => {
  let repo: InMemoryNotificationRepository;
  let inbox: InMemoryInboxAdapter;
  let deliver: DeliverInboxCommand;
  let query: NotificationQueryService;
  let seq = 0;
  let deliverSeq = 0;

  const NOW = '2026-09-10T00:00:00.000Z';

  beforeEach(() => {
    seq += 1;
    repo = new InMemoryNotificationRepository();
    inbox = new InMemoryInboxAdapter();
    deliver = new DeliverInboxCommand(repo, inbox, new InMemoryChannelDeliveryAttemptRepository());
    query = new NotificationQueryService(inbox);
  });

  async function deliverToUser(
    recipientId: string,
    opts: {
      eventType?: CreateNotificationFactInput['eventType'];
      deadlineAt?: string | null;
      summary?: string;
    } = {},
  ) {
    const n = deliverSeq++;
    const input: CreateNotificationFactInput = {
      // 每次投递使用唯一逻辑事件标识（NTF-003：同一逻辑事件＋收件人只允许一条）
      logicalEventId: `logical-q-${seq}-${recipientId}-${opts.eventType ?? 'conclusion'}-${n}`,
      sourceObjectId: `src-${seq}-${n}`,
      sourceObjectVersion: 1,
      sourceCommandId: `cmd-${seq}-${n}`,
      eventType: opts.eventType ?? 'conclusion',
      eventTime: '2026-09-08T00:00:00.000Z',
      summary: opts.summary ?? `通知 ${seq}`,
      targetObjectRef: '/me/1',
      deadlineAt: opts.deadlineAt ?? null,
      scope: { type: 'CLUB', clubId: 'club-1' },
    };
    const snapshot: RecipientSnapshot = {
      snapshotId: '',
      factId: '',
      recipientId,
      reason: '本人',
      scope: { type: 'CLUB', clubId: 'club-1' },
      dedupKey: input.logicalEventId,
      createdAt: '',
    };
    const saved = await repo.saveFactWithSnapshots(input, [snapshot]);
    await deliver.execute(saved.fact.factId, saved.fact.version);
    return saved.fact.factId;
  }

  /** 按事实标识取呈现（同一毫秒内投递时间相同，不能依赖列表顺序） */
  async function presentationOf(factId: string, recipientId: string) {
    const items = await inbox.listForUser(recipientId, {}, null, 100);
    const found = items.find((p) => p.factId === factId);
    assert.ok(found, `呈现不存在: factId=${factId}`);
    return found;
  }

  it('列表返回呈现子状态与有期限办理状态字段', async () => {
    await deliverToUser('stu-1', { deadlineAt: '2026-09-20T00:00:00.000Z' });
    const result = await query.listForUser('stu-1', {}, null, 20, NOW);
    assert.equal(result.items.length, 1);
    const item = result.items[0];
    assert.equal(item.status, 'unread');
    assert.equal(item.deadlineStatus, 'actionable');
    assert.equal(item.deadlineAt, '2026-09-20T00:00:00.000Z');
    assert.equal(item.read, false);
  });

  it('类型筛选只返回对应类型（kind）', async () => {
    await deliverToUser('stu-1', { eventType: 'interview' });
    await deliverToUser('stu-1', { eventType: 'conclusion' });
    const result = await query.listForUser('stu-1', { kind: 'interview' }, null, 20, NOW);
    assert.equal(result.items.length, 1);
    assert.equal(result.items[0].type, 'interview');
  });

  it('未读筛选只返回未读', async () => {
    const factId = await deliverToUser('stu-1', { eventType: 'member' });
    const pres = await presentationOf(factId, 'stu-1');
    await inbox.updatePresentationStatus(pres.presentationId, 'READ', pres.version);
    const result = await query.listForUser('stu-1', { unreadOnly: true }, null, 20, NOW);
    assert.equal(result.items.length, 0);
    const all = await query.listForUser('stu-1', {}, null, 20, NOW);
    assert.equal(all.items.length, 1);
  });

  it('主列表不展示隐藏；隐藏列表可查询（includeHidden）', async () => {
    const factId = await deliverToUser('stu-1');
    const pres = await presentationOf(factId, 'stu-1');
    await inbox.updatePresentationStatus(pres.presentationId, 'HIDDEN', pres.version);
    const main = await query.listForUser('stu-1', {}, null, 20, NOW);
    assert.equal(main.items.length, 0);
    const hidden = await query.listForUser('stu-1', { includeHidden: true }, null, 20, NOW);
    assert.equal(hidden.items.length, 1);
    assert.equal(hidden.items[0].status, 'hidden');
  });

  it('超过期限未处理 → 已过期 EXPIRED；已处理/已撤回保持终态', async () => {
    const past = '2026-09-01T00:00:00.000Z';
    const factId1 = await deliverToUser('stu-1', { deadlineAt: past });
    const factId2 = await deliverToUser('stu-1', { deadlineAt: past });
    const pres1 = await presentationOf(factId1, 'stu-1');
    const pres2 = await presentationOf(factId2, 'stu-1');
    // 一条标记已处理
    await inbox.updatePresentationStatus(pres2.presentationId, 'PROCESSED', pres2.version);

    const result = await query.listForUser('stu-1', {}, null, 20, NOW);
    const byId = new Map(result.items.map((i) => [i.id, i]));
    assert.equal(byId.get(pres1.presentationId)?.deadlineStatus, 'expired');
    assert.equal(byId.get(pres2.presentationId)?.deadlineStatus, 'processed');
  });

  it('未读数只统计未读（不含已处理/隐藏）', async () => {
    const factId = await deliverToUser('stu-1');
    const pres = await presentationOf(factId, 'stu-1');
    await inbox.updatePresentationStatus(pres.presentationId, 'READ', pres.version);
    const { count } = await query.unreadCount('stu-1');
    assert.equal(count, 0);
  });
});
