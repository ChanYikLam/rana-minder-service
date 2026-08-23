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
});
