/**
 * CreateNotificationFactCommand 测试。
 *
 * 覆盖 NTF-003：同一逻辑事件＋收件人唯一去重（findFactByDedupKey 幂等）。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { CreateNotificationFactCommand } from './create-notification-fact.command';
import { DefaultRecipientSnapshotResolver } from '../../domain/services';
import {
  InMemoryNotificationRepository,
  InMemoryInboxAdapter,
  InMemoryEmailAdapter,
  InMemoryChannelDeliveryAttemptRepository,
  InMemoryTemplateSnapshotService,
  InMemoryKillSwitchRepository,
} from '../../infrastructure';
import type { CreateNotificationFactInput } from '../../domain';

function makeInput(
  overrides: Partial<CreateNotificationFactInput> = {},
): CreateNotificationFactInput {
  return {
    logicalEventId: 'evt-001',
    sourceObjectId: 'rec-001',
    sourceObjectVersion: 1,
    sourceCommandId: 'cmd-001',
    eventType: 'invitation',
    eventTime: '2026-08-21T00:00:00.000Z',
    summary: '你已被邀请加入社团',
    targetObjectRef: '/clubs/club-001/recruitments/rec-001',
    scope: { type: 'CLUB', clubId: 'club-001' },
    ...overrides,
  };
}

describe('CreateNotificationFactCommand (NTF-003 去重)', () => {
  function setup() {
    const repository = new InMemoryNotificationRepository();
    const inboxAdapter = new InMemoryInboxAdapter();
    const emailAdapter = new InMemoryEmailAdapter();
    const attemptRepository = new InMemoryChannelDeliveryAttemptRepository();
    const templateService = new InMemoryTemplateSnapshotService();
    const resolver = new DefaultRecipientSnapshotResolver();
    const killSwitches = new InMemoryKillSwitchRepository();
    const command = new CreateNotificationFactCommand(repository, resolver, killSwitches);
    return { repository, inboxAdapter, emailAdapter, attemptRepository, templateService, command };
  }

  it('创建通知事实并保存收件人快照 (NTF-001)', async () => {
    const { repository, command } = setup();
    const result = await command.execute(makeInput());
    assert.equal(result.snapshotCount, 1);
    assert.ok(result.factId.length > 0);

    const fact = await repository.findFactById(result.factId);
    assert.ok(fact);
    assert.equal(fact.status, 'CREATED_PENDING_DELIVERY');

    const snapshots = await repository.findSnapshotsByFactId(result.factId);
    assert.equal(snapshots.length, 1);
    assert.equal(snapshots[0].recipientId, 'rec-001');
  });

  it('同一逻辑事件＋收件人重复创建 → 幂等跳过（NTF-003）', async () => {
    const { command } = setup();
    const first = await command.execute(makeInput());
    assert.equal(first.snapshotCount, 1);

    const second = await command.execute(makeInput());
    // 同一逻辑事件＋收件人已存在，全部去重后返回 0 条
    assert.equal(second.snapshotCount, 0);
    assert.equal(second.factId, '');
  });

  it('不同逻辑事件 → 各自创建，不去重（NTF-003）', async () => {
    const { command } = setup();
    const first = await command.execute(makeInput({ logicalEventId: 'evt-001' }));
    const second = await command.execute(makeInput({ logicalEventId: 'evt-002' }));
    assert.equal(first.snapshotCount, 1);
    assert.equal(second.snapshotCount, 1);
  });
});
