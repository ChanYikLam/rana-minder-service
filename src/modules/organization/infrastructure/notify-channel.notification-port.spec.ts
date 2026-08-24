/**
 * NotifyChannelNotificationPort：外部渠道桥接（IFC-TX-005 渠道失败不阻断）。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { NotifyAdapter } from '../../../adapters/notify/external-notify.adapter';
import type { ExternalResult } from '../../../common/contracts/external-result';
import { externalSuccess, externalFailure } from '../../../common/contracts/external-result';
import { NotifyChannelNotificationPort } from './notify-channel.notification-port';

function makeChannel(): { channel: NotifyAdapter; sent: string[]; fail: boolean } {
  const state = { sent: [] as string[], fail: false };
  const channel: NotifyAdapter = {
    async send(input) {
      if (state.fail) {
        return externalFailure(
          'UNAVAILABLE',
          { code: 'X', message: 'down', retryable: true, rawStatusCode: 503 },
          'att',
          new Date(),
        ) as ExternalResult<{ externalMessageId: string }>;
      }
      state.sent.push(`${input.recipient}:${input.idempotencyKey}`);
      return externalSuccess({ externalMessageId: 'm-1' }, 'att', new Date());
    },
  };
  return { channel, ...state };
}

const FACT = {
  kind: 'member',
  toUserIds: ['u_a', 'u_b'],
  clubId: 'club-1',
  title: '关系变更已生效',
  body: 'ok',
  dedupKey: 'rel-confirmed:r1',
};

describe('NotifyChannelNotificationPort', () => {
  it('逐收件人投递，幂等键 = dedupKey:userId', async () => {
    const { channel, sent } = makeChannel();
    await new NotifyChannelNotificationPort(channel).save(FACT);
    assert.deepEqual(sent, [`u_a:${FACT.dedupKey}:u_a`, `u_b:${FACT.dedupKey}:u_b`]);
  });

  it('渠道不可用/抛错不阻断主事务（save 不 reject）', async () => {
    const failing = makeChannel();
    failing.fail = true;
    const throwing: NotifyAdapter = {
      async send() {
        throw new Error('network down');
      },
    };
    await assert.doesNotReject(() => new NotifyChannelNotificationPort(failing.channel).save(FACT));
    await assert.doesNotReject(() => new NotifyChannelNotificationPort(throwing).save(FACT));
  });

  it('失败结构化留痕：环形缓冲记录 + 持久化 sink 转发（评审：31-42）', async () => {
    const failures: Array<{ dedupKey: string; recipient: string; reason: string }> = [];
    const sink = (f: { dedupKey: string; recipient: string; reason: string }) => {
      failures.push(f);
    };
    // 渠道对 u_a 失败（未确认）、u_b 抛异常
    const channel: NotifyAdapter = {
      async send(input) {
        if (input.recipient === 'u_a') {
          return externalFailure(
            'UNAVAILABLE',
            { code: 'X', message: 'down', retryable: true, rawStatusCode: 503 },
            'att',
            new Date(),
          ) as ExternalResult<{ externalMessageId: string }>;
        }
        throw new Error('network down');
      },
    };
    const port = new NotifyChannelNotificationPort(channel, sink);
    await port.save(FACT);

    assert.equal(port.deliveryFailures.length, 2);
    assert.deepEqual(
      port.deliveryFailures.map((f) => f.recipient),
      ['u_a', 'u_b'],
    );
    assert.ok(port.deliveryFailures.every((f) => f.dedupKey === FACT.dedupKey));
    assert.ok(port.deliveryFailures.every((f) => f.occurredAt.length > 0));
    assert.equal(failures.length, 2); // sink 收到同样的留痕（持久化落点）
  });

  it('sink 自身抛错不阻断主事务（降级为日志）', async () => {
    const channel: NotifyAdapter = {
      async send() {
        throw new Error('network down');
      },
    };
    const port = new NotifyChannelNotificationPort(channel, () => {
      throw new Error('sink storage unavailable');
    });
    await assert.doesNotReject(() => port.save(FACT));
    assert.equal(port.deliveryFailures.length, FACT.toUserIds.length); // 缓冲仍记录
  });

  it('投递全部成功时不产生失败留痕', async () => {
    const { channel } = makeChannel();
    const port = new NotifyChannelNotificationPort(channel);
    await port.save(FACT);
    assert.equal(port.deliveryFailures.length, 0);
  });
});
