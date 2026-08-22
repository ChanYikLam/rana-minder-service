/**
 * SmtpMailChannelAdapter（真实 SMTP 渠道）单元测试（T3 接线自审补测）。
 *
 * 覆盖：多行响应分片到达时仅以最终状态行（`<码> `）收口（不因 continuation 行
 * `<码>-` 过早判定完成）、DATA 阶段最终响应收口、AUTH 流程、失败分类。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { SmtpMailChannelAdapter, type SmtpMailAdapterOptions } from './smtp-mail.adapter';
import type { Socket } from 'node:net';
import type { VerificationEmailDispatch } from './mail-channel-adapter';

/** 基于 EventEmitter 的最小 Socket mock，按脚本队列依次触发 data。 */
class FakeSocket extends EventEmitter {
  written: string[] = [];
  private script: string[][];
  private destroyed = false;

  constructor(script: string[][]) {
    super();
    this.script = script;
  }

  write(data: string, _enc?: unknown, cb?: () => void): boolean {
    this.written.push(data);
    // 依命令触发对应响应（可按 chunk 数组分片推送）。
    const chunk = this.script.shift();
    if (chunk) {
      for (const c of chunk) {
        this.emit('data', Buffer.from(c, 'utf8'));
      }
    }
    if (cb) cb();
    return true;
  }

  /** 连接建立：先触发 connect（banner 阶段注册 data 监听），再推送 banner。 */
  emitConnect(): void {
    this.emit('connect');
    const banner = this.script.shift();
    if (banner) {
      for (const c of banner) {
        this.emit('data', Buffer.from(c, 'utf8'));
      }
    }
  }

  destroy(): this {
    this.destroyed = true;
    return this;
  }

  get destroyedFlag(): boolean {
    return this.destroyed;
  }
}

function connectFn(socket: FakeSocket): typeof import('node:net').createConnection {
  return (() => {
    // 连接建立后，先推送 banner（首个响应），再触发 connect 事件。
    process.nextTick(() => {
      socket.emitConnect();
    });
    return socket as unknown as Socket;
  }) as unknown as typeof import('node:net').createConnection;
}

function makeAdapter(socket: FakeSocket, extra?: Partial<SmtpMailAdapterOptions>) {
  return new SmtpMailChannelAdapter({
    host: 'smtp.example.com',
    port: 25,
    fromAddress: 'no-reply@example.com',
    timeoutMs: 2000,
    connectFn: connectFn(socket),
    ...extra,
  });
}

function dispatch(): VerificationEmailDispatch {
  return {
    subjectId: 'subj-1',
    toEmail: 'user@example.com',
    code: '123456',
    expiresAt: new Date('2026-08-22T00:01:00Z'),
    externalMessageId: '<test-1@example.com>',
  };
}

describe('SmtpMailChannelAdapter（真实 SMTP 渠道）', () => {
  it('EHLO 多行响应分片到达：仅以最终状态行收口，成功投递', async () => {
    const socket = new FakeSocket([
      // banner：单 chunk 到达
      ['220 smtp.example.com ESMTP\r\n'],
      // EHLO：continuation 行先到（不应收口），最终行后到
      ['250-smtp.example.com Hello\r\n250-SIZE 10240000\r\n', '250-PIPELINING\r\n250 HELP\r\n'],
      // MAIL FROM
      ['250 OK\r\n'],
      // RCPT TO
      ['250 OK\r\n'],
      // DATA 起始
      ['354 End data with <CR><LF>.<CR><LF>\r\n'],
      // DATA 结束最终响应
      ['250 OK: queued as 1AbC\r\n'],
    ]);
    const adapter = makeAdapter(socket);
    const res = await adapter.sendVerificationEmail(dispatch());
    assert.equal(res.status, 'SUCCESS');
    // EHLO 阶段收到的 continuation 行不应导致后续命令被跳过。
    assert.ok(socket.written.some((w) => w.startsWith('MAIL FROM')));
    assert.ok(socket.written.some((w) => w.startsWith('RCPT TO')));
  });

  it('AUTH LOGIN 流程：凭据被 base64 编码后发送', async () => {
    const socket = new FakeSocket([
      ['220 smtp.example.com ESMTP\r\n'],
      ['250-smtp.example.com Hello\r\n250 HELP\r\n'],
      ['334 VXNlcm5hbWU6\r\n'],
      ['334 UGFzc3dvcmQ6\r\n'],
      ['235 Authentication successful\r\n'],
      ['250 OK\r\n'],
      ['250 OK\r\n'],
      ['354 End data\r\n'],
      ['250 OK queued\r\n'],
    ]);
    const adapter = makeAdapter(socket, {
      user: 'admin',
      password: 's3cret',
    });
    const res = await adapter.sendVerificationEmail(dispatch());
    assert.equal(res.status, 'SUCCESS');
    const encoded = socket.written
      .map((w) => w.trim())
      .filter((w) => w.length > 0 && !w.includes(' '));
    assert.ok(encoded.includes(Buffer.from('admin', 'utf8').toString('base64')));
    assert.ok(encoded.includes(Buffer.from('s3cret', 'utf8').toString('base64')));
  });

  it('RCPT 5xx 拒绝 → NON_RETRYABLE', async () => {
    const socket = new FakeSocket([
      ['220 smtp.example.com ESMTP\r\n'],
      ['250-smtp.example.com Hello\r\n250 HELP\r\n'],
      ['250 OK\r\n'],
      ['550 No such user\r\n'],
    ]);
    const adapter = makeAdapter(socket);
    const res = await adapter.sendVerificationEmail(dispatch());
    assert.equal(res.status, 'NON_RETRYABLE');
    assert.equal(res.error?.code, 'MAIL-REJECTED');
  });

  it('DATA 最终响应非 2xx → RETRYABLE_FAILURE', async () => {
    const socket = new FakeSocket([
      ['220 smtp.example.com ESMTP\r\n'],
      ['250-smtp.example.com Hello\r\n250 HELP\r\n'],
      ['250 OK\r\n'],
      ['250 OK\r\n'],
      ['354 End data\r\n'],
      ['451 Temporary local problem\r\n'],
    ]);
    const adapter = makeAdapter(socket);
    const res = await adapter.sendVerificationEmail(dispatch());
    assert.equal(res.status, 'RETRYABLE_FAILURE');
  });

  it('连接超时 → RETRYABLE_FAILURE', async () => {
    const socket = new FakeSocket([]);
    // 不触发 connect，且 connectFn 仍按 nextTick 触发 connect；这里通过短 timeout 制造超时。
    const adapter = new SmtpMailChannelAdapter({
      host: 'smtp.example.com',
      port: 25,
      fromAddress: 'no-reply@example.com',
      timeoutMs: 20,
      connectFn: connectFn(socket),
    });
    const res = await adapter.sendVerificationEmail(dispatch());
    assert.equal(res.status, 'RETRYABLE_FAILURE');
  });
});
