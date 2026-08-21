/**
 * 创建通知事实去重测试（评审 #5：真正执行 findFactByDedupKey，
 * 去重键统一为 逻辑事件＋收件人）。
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { InMemoryNotificationRepository, InMemoryKillSwitchRepository } from '../../infrastructure';
import { buildDedupKey } from '../../domain';
import { CreateNotificationFactCommand } from './create-notification-fact.command';
import type { CreateNotificationFactInput } from '../../domain';

describe('CreateNotificationFactCommand 去重（NTF-003、评审 #5）', () => {
  let repo: InMemoryNotificationRepository;
  let command: CreateNotificationFactCommand;
  let seq = 0;

  beforeEach(() => {
    seq += 1;
    repo = new InMemoryNotificationRepository();
    command = new CreateNotificationFactCommand(
      repo,
      {
        resolve: () => ({
          recipients: [
            {
              recipientId: 'stu-1',
              reason: '本人',
              scope: { type: 'CLUB' as const, clubId: 'club-1' },
              dedupKey: '', // 由命令重建
            },
          ],
          resolutionRationale: 'test',
        }),
      },
      new InMemoryKillSwitchRepository(),
    );
  });

  function input(logicalEventId: string): CreateNotificationFactInput {
    return {
      logicalEventId,
      sourceObjectId: `src-${seq}`,
      sourceObjectVersion: 1,
      sourceCommandId: `cmd-${seq}`,
      eventType: 'conclusion',
      eventTime: '2026-09-08T00:00:00.000Z',
      summary: `结论通知 ${seq}`,
      targetObjectRef: '/me/1',
      scope: { type: 'CLUB', clubId: 'club-1' },
    };
  }

  it('去重键统一为 逻辑事件＋收件人（DATA-NTF-001）', async () => {
    await command.execute(input('logical-1'));
    const snapshots = await repo.findSnapshotsByFactId(
      (await repo.findFactByDedupKey(buildDedupKey('logical-1', 'stu-1')))!.factId,
    );
    assert.equal(snapshots[0].dedupKey, buildDedupKey('logical-1', 'stu-1'));
    assert.equal(snapshots[0].dedupKey, 'logical-1\u0000stu-1');
  });

  it('同一逻辑事件＋收件人重复创建 → 去重跳过，不产生新事实（NTF-003）', async () => {
    const first = await command.execute(input('logical-dup'));
    assert.equal(first.deduplicated, false);
    assert.ok(first.factId);

    const second = await command.execute(input('logical-dup'));
    assert.equal(second.deduplicated, true);
    assert.equal(second.factId, '');
    assert.equal(second.snapshotCount, 0);

    const pending = await repo.findFactsPendingDelivery(100);
    assert.equal(pending.length, 1, '不允许产生第二份通知事实');
  });

  it('不同逻辑事件互不影响', async () => {
    await command.execute(input('logical-a'));
    const other = await command.execute(input('logical-b'));
    assert.equal(other.deduplicated, false);
  });
});
