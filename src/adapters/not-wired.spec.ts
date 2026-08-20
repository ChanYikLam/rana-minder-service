/**
 * 平台适配桩（adapters；未连接态失败关闭）单元测试。
 *
 * 覆盖：DB 桩所有操作抛 DbUnavailableError；Casdoor/Mail 桩返回 UNAVAILABLE
 * （不伪成功、不伪造可信回读，IFC-ERR-012 语义）。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { NotWiredDbAdapter, DbUnavailableError } from './db/not-wired-db.adapter';
import { NotWiredCasdoorAdapter } from './casdoor/not-wired-casdoor.adapter';
import { NotWiredMailChannelAdapter } from './mail/not-wired-mail.adapter';

describe('NotWiredDbAdapter（DB 未连接失败关闭）', () => {
  it('全部数据库操作抛 DbUnavailableError（不静默成功）', async () => {
    const db = new NotWiredDbAdapter();
    await assert.rejects(db.beginTransaction(), DbUnavailableError);
    await assert.rejects(db.query({ id: 'tx-1' }, 'SELECT 1', []), DbUnavailableError);
    await assert.rejects(db.commit({ id: 'tx-1' }), DbUnavailableError);
    await assert.rejects(db.rollback({ id: 'tx-1' }), DbUnavailableError);
    await assert.rejects(
      db.setRlsContext({ id: 'tx-1' }, { kind: 'single', subjectId: 'u' }),
      DbUnavailableError,
    );
    await assert.rejects(db.clearRlsContext({ id: 'tx-1' }), DbUnavailableError);
  });
});

describe('NotWiredCasdoorAdapter（Casdoor 未连接失败关闭）', () => {
  it('getUser/updateUser 一律返回 UNAVAILABLE（不伪造可信读回）', async () => {
    const casdoor = new NotWiredCasdoorAdapter();
    const read = await casdoor.getUser('user-1');
    assert.equal(read.status, 'UNAVAILABLE');
    assert.equal(read.data, null);
    assert.equal(read.error?.retryable, true);
    const write = await casdoor.updateUser('user-1', { phone: '139' });
    assert.equal(write.status, 'UNAVAILABLE');
    assert.equal(write.data, null);
  });
});

describe('NotWiredMailChannelAdapter（邮件未连接失败关闭）', () => {
  it('sendVerificationEmail 返回 UNAVAILABLE（不绕过邮箱验证）', async () => {
    const mail = new NotWiredMailChannelAdapter();
    const result = await mail.sendVerificationEmail({
      subjectId: 'user-1',
      toEmail: 'a@example.com',
      code: 'v-1:secret',
      expiresAt: new Date(),
      externalMessageId: null,
    });
    assert.equal(result.status, 'UNAVAILABLE');
    assert.equal(result.error?.code, 'MAIL-NOT-WIRED');
  });
});
