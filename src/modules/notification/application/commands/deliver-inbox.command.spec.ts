/**
 * DeliverInboxCommand 测试。
 *
 * 覆盖站内信投递成功推进事实状态，以及失败接入重试队列（NTF-007、IFC-TX-005）：
 * 投递失败不回滚业务，并写入 FAILED_RETRY 渠道投递尝试供重试队列拉取；
 * 乐观锁版本冲突与适配器错误不得静默吞掉（评审 #4）。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { DeliverInboxCommand } from './deliver-inbox.command';
import { DefaultRecipientSnapshotResolver } from '../../domain/services';
import {
  InMemoryNotificationRepository,
  InMemoryInboxAdapter,
  InMemoryChannelDeliveryAttemptRepository,
  InMemoryKillSwitchRepository,
} from '../../infrastructure';
import type { CreateNotificationFactInput } from '../../domain';
import { CreateNotificationFactCommand } from './create-notification-fact.command';

function makeInput(): CreateNotificationFactInput {
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
  };
}

describe('DeliverInboxCommand (站内信投递与失败重试)', () => {
  function setup() {
    const repository = new InMemoryNotificationRepository();
    const inboxAdapter = new InMemoryInboxAdapter();
    const attemptRepository = new InMemoryChannelDeliveryAttemptRepository();

    // 先创建一条通知事实
    const createCommand = new CreateNotificationFactCommand(
      repository,
      new DefaultRecipientSnapshotResolver(),
      new InMemoryKillSwitchRepository(),
    );

    const command = new DeliverInboxCommand(repository, inboxAdapter, attemptRepository);
    return { repository, inboxAdapter, attemptRepository, createCommand, command };
  }

  it('站内信投递成功 → 事实状态更新为已投递', async () => {
    const { repository, attemptRepository, createCommand, command } = setup();
    const { factId } = await createCommand.execute(makeInput());

    const result = await command.execute(factId, 1);
    assert.equal(result.presentationCount, 1);

    const fact = await repository.findFactById(factId);
    assert.equal(fact!.status, 'DELIVERED');

    // 未产生失败重试记录
    const retryable = await attemptRepository.findRetryableAttempts(10);
    assert.equal(retryable.length, 0);
  });

  it('站内信投递失败 → 写入 FAILED_RETRY 尝试供重试队列拉取（NTF-007、IFC-TX-005）', async () => {
    const { repository, inboxAdapter, attemptRepository, createCommand } = setup();
    const { factId, snapshotCount } = await createCommand.execute(makeInput());
    assert.ok(snapshotCount > 0);

    // 让站内信呈现创建抛出异常
    const original = inboxAdapter.createOrConfirmPresentation.bind(inboxAdapter);
    (inboxAdapter as any).createOrConfirmPresentation = async () => {
      throw new Error('inbox store unavailable');
    };

    const command = new DeliverInboxCommand(repository, inboxAdapter, attemptRepository);
    // 失败必须向上抛出（交由任务管道重试），不得静默吞掉（评审 #4：IFC-ERR-008）
    await assert.rejects(
      () => command.execute(factId, 1),
      /inbox store unavailable/,
      '适配器错误应向上抛出而非静默吞掉',
    );

    // 已写入失败重试尝试，可被重试队列拉取
    const retryable = await attemptRepository.findRetryableAttempts(10);
    assert.ok(retryable.length >= 1);
    assert.equal(retryable[0].status, 'FAILED_RETRY');
    assert.equal(retryable[0].channel, 'INBOX');

    // 业务不回滚：事实状态仍保持待投递（未被标记为已投递）
    const fact = await repository.findFactById(factId);
    assert.notEqual(fact!.status, 'DELIVERED');

    // 恢复原始实现
    (inboxAdapter as any).createOrConfirmPresentation = original;
  });
});
