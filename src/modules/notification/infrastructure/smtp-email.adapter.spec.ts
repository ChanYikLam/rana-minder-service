/**
 * SmtpEmailAdapter 单测（4.3 收口；fake socket 模拟 SMTP 会话）。
 *
 * 覆盖：EHLO→AUTH→MAIL→RCPT→DATA 成功 → SENT；RCPT 5xx → BOUNCE；
 * DATA 5xx → BOUNCE；DATA 4xx → TEMPORARY_FAILURE；断连 → TEMPORARY_FAILURE；
 * 未配置 → 构造抛错 fail-closed。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { Socket } from 'node:net';

import { SmtpEmailAdapter } from './smtp-email.adapter';
import type { EmailSendInput } from './notification-ports';

const INPUT: EmailSendInput = {
  to: 'stu@example.com',
  subject: '面试通知',
  body: '<p>你好</p>',
  senderIdentity: 'club-1',
  templateVersionId: null,
  fromAddress: 'no-reply@ranaminder.cn',
  replyTo: 'no-reply@ranaminder.cn',
};

/** fake socket：write 记录命令并按 responder 应答；banner 连接后主动 220 */
function makeFakeSocket(responder: (cmd: string) => string, sent: string[]): Socket {
  const socket = new EventEmitter() as Socket;
  (socket as unknown as { write: (d: string) => void }).write = (d: string) => {
    const cmd = d.replace(/\r\n$/, '');
    sent.push(cmd);
    socket.emit('data', Buffer.from(`${responder(cmd)}\r\n`));
  };
  (socket as unknown as { destroy: () => void }).destroy = () => undefined;
  process.nextTick(() => {
    socket.emit('connect');
    socket.emit('data', Buffer.from('220 smtp.example.com ESMTP\r\n'));
  });
  return socket;
}

function makeAdapter(script: Record<string, string>): {
  adapter: SmtpEmailAdapter;
  sent: string[];
} {
  const sent: string[] = [];
  const responder = (cmd: string): string => {
    if (cmd.startsWith('EHLO')) return '250 ok';
    if (cmd === 'AUTH LOGIN') return '334 VXNlcm5hbWU6';
    if (cmd === Buffer.from('user', 'utf8').toString('base64')) return '334 UGFzc3dvcmQ6';
    if (cmd === Buffer.from('pass', 'utf8').toString('base64'))
      return '235 2.7.0 Authentication successful';
    if (cmd.startsWith('MAIL FROM')) return '250 2.1.0 Ok';
    if (cmd.startsWith('RCPT TO')) return script['rcpt'] ?? '250 2.1.5 Ok';
    if (cmd === 'DATA') return '354 End data with <CR><LF>.<CR><LF>';
    if (cmd.includes('\r\n') || cmd === '.') return script['data'] ?? '250 2.0.0 Ok: queued';
    return '250 ok';
  };
  const connectFn = (_port: number, _host: string): Socket => makeFakeSocket(responder, sent);
  const adapter = new SmtpEmailAdapter({
    host: 'smtp.example.com',
    port: 465,
    fromAddress: 'no-reply@ranaminder.cn',
    user: 'user',
    password: 'pass',
    connectFn,
  });
  return { adapter, sent };
}

describe('SmtpEmailAdapter（4.3 收口）', () => {
  it('构造：缺 host/fromAddress → 抛错 fail-closed（禁止静默假发送）', () => {
    assert.throws(
      () => new SmtpEmailAdapter({ host: '', port: 465, fromAddress: '' }),
      /fail-closed/,
    );
  });

  it('完整会话成功 → SENT（信封 From 固定配置地址）', async () => {
    const { adapter, sent } = makeAdapter({});
    const result = await adapter.send(INPUT);
    assert.equal(result.status, 'SENT');
    // 信封 From 固定为配置 fromAddress（NTF-008/009）
    assert.ok(sent.some((c) => c.startsWith('MAIL FROM:<no-reply@ranaminder.cn>')));
    assert.ok(sent.some((c) => c.startsWith('RCPT TO:<stu@example.com>')));
    assert.ok(sent.includes('DATA'));
  });

  it('RCPT 5xx → BOUNCE（收件人地址级永久失败）', async () => {
    const { adapter } = makeAdapter({ rcpt: '550 5.1.1 No such user' });
    const result = await adapter.send(INPUT);
    assert.equal(result.status, 'BOUNCE');
  });

  it('DATA 5xx → BOUNCE（永久失败不可重试）', async () => {
    const { adapter } = makeAdapter({ data: '554 5.7.1 Message rejected' });
    const result = await adapter.send(INPUT);
    assert.equal(result.status, 'BOUNCE');
  });

  it('DATA 4xx → TEMPORARY_FAILURE（可重试）', async () => {
    const { adapter } = makeAdapter({ data: '451 4.3.0 Try again later' });
    const result = await adapter.send(INPUT);
    assert.equal(result.status, 'TEMPORARY_FAILURE');
  });

  it('连接断连（banner 超时）→ TEMPORARY_FAILURE（错误脱敏）', async () => {
    const connectFn = (_port: number, _host: string): Socket => {
      const socket = new EventEmitter() as Socket;
      (socket as unknown as { write: () => void }).write = () => undefined;
      (socket as unknown as { destroy: () => void }).destroy = () => undefined;
      // 不 emit connect → banner 等待超时
      return socket;
    };
    const adapter = new SmtpEmailAdapter({
      host: 'smtp.example.com',
      port: 465,
      fromAddress: 'no-reply@ranaminder.cn',
      timeoutMs: 50,
      connectFn,
    });
    const result = await adapter.send(INPUT);
    assert.equal(result.status, 'TEMPORARY_FAILURE');
    assert.ok(result.sanitizedError === null || result.sanitizedError.includes('smtp'));
  });
});
