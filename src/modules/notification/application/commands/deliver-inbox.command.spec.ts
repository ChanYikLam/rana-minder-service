/**
 * 站内信投递命令测试（评审 #4：失败必须抛出，不得静默吞掉；
 * 乐观锁版本冲突、适配器错误可见可重试）。
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { InMemoryInboxAdapter, InMemoryNotificationRepository } from '../../infrastructure';
import { DeliverInboxCommand } from './deliver-inbox.command';
import type { CreateNotificationFactInput, RecipientSnapshot } from '../../domain';

describe('DeliverInboxCommand（评审 #4：失败可见）', () => {
  let repo: InMemoryNotificationRepository;
  let inbox: InMemoryInboxAdapter;
  let deliver: DeliverInboxCommand;
  let seq = 0;

  beforeEach(() => {
    seq += 1;
    repo = new InMemoryNotificationRepository();
    inbox = new InMemoryInboxAdapter();
    deliver = new DeliverInboxCommand(repo, inbox);
  });

  async function createFact(): Promise<string> {
    const input: CreateNotificationFactInput = {
      logicalEventId: `logical-${seq}`,
      sourceObjectId: `src-${seq}`,
      sourceObjectVersion: 1,
      sourceCommandId: `cmd-${seq}`,
      eventType: 'conclusion',
      eventTime: '2026-09-08T00:00:00.000Z',
      summary: `结论通知 ${seq}`,
      targetObjectRef: '/me/1',
      scope: { type: 'CLUB', clubId: 'club-1' },
    };
    const snapshot: RecipientSnapshot = {
      snapshotId: '',
      factId: '',
      recipientId: 'stu-1',
      reason: '本人',
      scope: { type: 'CLUB', clubId: 'club-1' },
      dedupKey: input.logicalEventId,
      createdAt: '',
    };
    const saved = await repo.saveFactWithSnapshots(input, [snapshot]);
    return saved.fact.factId;
  }

  it('正常投递创建呈现并推进事实状态', async () => {
    const factId = await createFact();
    const result = await deliver.execute(factId, 1);
    assert.equal(result.presentationCount, 1);
    const fact = await repo.findFactById(factId);
    assert.equal(fact?.status, 'DELIVERED');
    const items = await inbox.listForUser('stu-1', {}, null, 100);
    assert.equal(items.length, 1);
  });

  it('乐观锁版本冲突 → 向上抛出（不再静默吞掉）', async () => {
    const factId = await createFact();
    await deliver.execute(factId, 1);
    // 用过期版本再次投递 → 版本冲突必须抛出
    await assert.rejects(deliver.execute(factId, 1), /版本冲突/);
  });

  it('已投递事实重复投递 → 幂等，不重复创建呈现', async () => {
    const factId = await createFact();
    await deliver.execute(factId, 1);
    const second = await deliver.execute(factId, 2);
    assert.equal(second.presentationCount, 1, '确认呈现（去重返回既有呈现）');
    const items = await inbox.listForUser('stu-1', {}, null, 100);
    assert.equal(items.length, 1, '不重复创建呈现');
  });
});
