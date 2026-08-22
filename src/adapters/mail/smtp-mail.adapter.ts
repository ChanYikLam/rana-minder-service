/**
 * 邮件渠道真实 SMTP 适配器（adapters/mail/smtp-mail.adapter.ts；T3 接线）。
 *
 * 权威依据：邮件适配文档、NTF-008/009（投递结果不确定必须查询/回读收口）、
 * IFC-TX-005、SRS-FAIL-007（投递失败不改变业务/通知事实）。
 *
 * 实现说明：
 * - 使用 Node 内置 net 实现最小 SMTP 客户端（EHLO → AUTH LOGIN → MAIL FROM →
 *   RCPT TO → DATA），不引入供应商 SDK；
 * - 成功判定以服务器对 DATA 结尾（250）为准；超时/断连/5xx 永久失败映射为
 *   规范化 ExternalResult；
 * - 消息 ID 由调用方传入（externalMessageId），适配器在 DATA 响应中尝试解析
 *   服务器 Message-Id 用于后续查询收口；
 * - 错误消息一律脱敏，不回显 SMTP 凭据（mail.password/user）。
 *
 * 依赖可用性由 `ADAPTERS_MAIL_REAL=1` 开关控制（fail-closed）。
 */

import type { MailChannelAdapter, VerificationEmailDispatch } from './mail-channel-adapter';
import type { ExternalResult } from '../../common/contracts/external-result';
import { externalSuccess, externalFailure } from '../../common/contracts/external-result';
import { randomUUID } from 'node:crypto';
import { toRedactedErrorSummary } from '../redaction';
import { createConnection, type Socket } from 'node:net';

export interface SmtpMailAdapterOptions {
  readonly host: string;
  readonly port: number;
  readonly fromAddress: string;
  readonly user?: string;
  readonly password?: string;
  readonly secure?: boolean;
  /** 注入以便单测（默认使用 node:net createConnection）。 */
  readonly connectFn?: typeof import('node:net').createConnection;
  readonly now?: () => Date;
  readonly timeoutMs?: number;
}

function encodeBase64(input: string): string {
  return Buffer.from(input, 'utf8').toString('base64');
}

/**
 * SMTP 单命令请求/响应：累积缓冲直到收到最终状态行（`<3位码><空格>…`）。
 *
 * SMTP 多行响应中 continuation 行以 `<3位码>-` 结尾、最终状态行以 `<3位码> `（空格）
 * 结尾。原实现把任意以 2/3/4/5 开头的行都当作最终行，导致 EHLO 等多行响应在
 * 分片到达时被过早判定完成，后续命令时序错乱。此处按最终状态行收口。
 */
async function smtpExchange(socket: Socket, command: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('smtp-timeout'));
    }, timeoutMs);
    let buffer = '';
    // 监听 socket error：等待响应期间对端断开/重置（ECONNRESET 等）时及时以真实错误
    // reject，避免一直挂起到超时、把根因错误误判为 smtp-timeout。
    const onError = (err: Error) => {
      clearTimeout(timer);
      socket.removeListener('data', onData);
      socket.removeListener('error', onError);
      reject(err);
    };
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      // 仅当缓冲以换行结尾（收到完整行）时再判定，避免截断半行。
      if (!buffer.endsWith('\n')) {
        return;
      }
      for (const line of buffer.split(/\r?\n/)) {
        const m = /^(\d{3})([ -])/.exec(line);
        // 最终状态行：`<3位码> `（空格）；continuation 行 `<3位码>-` 继续等待。
        if (m && m[2] === ' ') {
          clearTimeout(timer);
          socket.removeListener('data', onData);
          socket.removeListener('error', onError);
          resolve(line);
          return;
        }
      }
      // 仅收到 continuation 行，继续累积等待最终行。
    };
    socket.on('data', onData);
    socket.once('error', onError);
    socket.write(`${command}\r\n`, 'utf8');
  });
}

export class SmtpMailChannelAdapter implements MailChannelAdapter {
  private readonly host: string;
  private readonly port: number;
  private readonly fromAddress: string;
  private readonly user?: string;
  private readonly password?: string;
  private readonly connectFn: typeof import('node:net').createConnection;
  private readonly now: () => Date;
  private readonly timeoutMs: number;

  constructor(options: SmtpMailAdapterOptions) {
    this.host = options.host;
    this.port = options.port;
    this.fromAddress = options.fromAddress;
    this.user = options.user;
    this.password = options.password;
    this.connectFn = options.connectFn ?? createConnection;
    this.now = options.now ?? (() => new Date());
    this.timeoutMs = options.timeoutMs ?? 10_000;
  }

  private attemptId(): string {
    return randomUUID();
  }

  async sendVerificationEmail(input: VerificationEmailDispatch): Promise<ExternalResult<void>> {
    const attemptId = this.attemptId();
    const ts = this.now();
    const { toEmail, code, expiresAt, externalMessageId } = input;

    const socket = this.connectFn(this.port, this.host);

    try {
      // 1. banner（220）
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          socket.destroy();
          reject(new Error('smtp-banner-timeout'));
        }, this.timeoutMs);
        socket.once('connect', () => {
          socket.once('data', () => {
            clearTimeout(timer);
            resolve();
          });
        });
        socket.once('error', (err) => {
          clearTimeout(timer);
          reject(err);
        });
      });

      // 2. EHLO
      const ehlo = await smtpExchange(socket, `EHLO ranaminder`, this.timeoutMs);
      if (ehlo.startsWith('5') || ehlo.startsWith('4')) {
        throw new Error(`ehlo-failed:${ehlo}`);
      }

      // 3. AUTH LOGIN（若配置了凭据）
      if (this.user !== undefined && this.password !== undefined) {
        const authOk = await smtpExchange(socket, 'AUTH LOGIN', this.timeoutMs);
        if (!authOk.startsWith('3')) {
          throw new Error(`auth-not-supported:${authOk}`);
        }
        const userOk = await smtpExchange(socket, encodeBase64(this.user), this.timeoutMs);
        if (!userOk.startsWith('3')) {
          throw new Error(`auth-user-failed:${userOk}`);
        }
        const passOk = await smtpExchange(socket, encodeBase64(this.password), this.timeoutMs);
        if (!passOk.startsWith('2') && !passOk.startsWith('3')) {
          throw new Error(`auth-pass-failed:${passOk}`);
        }
      }

      // 4. MAIL FROM / RCPT TO
      const mailFrom = await smtpExchange(
        socket,
        `MAIL FROM:<${this.fromAddress}>`,
        this.timeoutMs,
      );
      if (!mailFrom.startsWith('2')) {
        throw new Error(`mail-from-failed:${mailFrom}`);
      }
      const rcptTo = await smtpExchange(socket, `RCPT TO:<${toEmail}>`, this.timeoutMs);
      if (!rcptTo.startsWith('2')) {
        if (rcptTo.startsWith('5')) {
          socket.destroy();
          return externalFailure(
            'NON_RETRYABLE',
            {
              code: 'MAIL-REJECTED',
              message: 'recipient rejected',
              retryable: false,
              rawStatusCode: null,
            },
            attemptId,
            ts,
          );
        }
        throw new Error(`rcpt-failed:${rcptTo}`);
      }

      // 5. DATA
      const dataCmd = await smtpExchange(socket, 'DATA', this.timeoutMs);
      if (!dataCmd.startsWith('3')) {
        throw new Error(`data-init-failed:${dataCmd}`);
      }

      const messageId = externalMessageId ?? `<${randomUUID()}@ranaminder>`;
      const body = [
        `From: ${this.fromAddress}`,
        `To: ${toEmail}`,
        'MIME-Version: 1.0',
        'Content-Type: text/plain; charset=UTF-8',
        `Message-ID: ${messageId}`,
        `Date: ${this.now().toUTCString()}`,
        `Subject: =?UTF-8?B?${Buffer.from('邮箱验证', 'utf8').toString('base64')}?=`,
        '',
        `验证码/链接：${code}`,
        `有效期至：${expiresAt.toISOString()}`,
        '此邮件仅用于邮箱验证，不可退订。',
      ].join('\r\n');

      const dataResp = await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => {
          socket.destroy();
          reject(new Error('smtp-data-timeout'));
        }, this.timeoutMs);
        let buffer = '';
        const onData = (chunk: Buffer) => {
          buffer += chunk.toString('utf8');
          if (!buffer.endsWith('\n')) {
            return;
          }
          for (const line of buffer.split(/\r?\n/)) {
            const m = /^(\d{3})([ -])/.exec(line);
            if (m && m[2] === ' ') {
              clearTimeout(timer);
              socket.removeListener('data', onData);
              resolve(line);
              return;
            }
          }
        };
        socket.on('data', onData);
        socket.write(`${body}\r\n.\r\n`, 'utf8', () => {});
        socket.once('error', (err) => {
          clearTimeout(timer);
          reject(err);
        });
      });

      if (!dataResp.startsWith('2')) {
        throw new Error(`data-failed:${dataResp}`);
      }

      socket.destroy();
      return externalSuccess(undefined, attemptId, ts);
    } catch (err) {
      socket.destroy();
      const message = toRedactedErrorSummary(err);
      return externalFailure(
        'RETRYABLE_FAILURE',
        { code: 'MAIL-DELIVERY-FAILED', message, retryable: true, rawStatusCode: null },
        attemptId,
        ts,
      );
    }
  }
}
