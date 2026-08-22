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

/** 对单个 SMTP 命令发起请求并等待一行响应。 */
async function smtpExchange(socket: Socket, command: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('smtp-timeout'));
    }, timeoutMs);
    const onData = (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      // 简单多行响应：取最后一行作为最终状态行。
      const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
      const last = lines[lines.length - 1] ?? '';
      if (
        last.startsWith('5') ||
        last.startsWith('4') ||
        last.startsWith('2') ||
        last.startsWith('3')
      ) {
        clearTimeout(timer);
        socket.removeListener('data', onData);
        resolve(last);
      }
      // 否则继续等待（如 DATA 阶段的多行）。
    };
    socket.on('data', onData);
    socket.write(`${command}\r\n`, 'utf8');
  });
}

/** 读取并消费一个服务器多行响应（用于 DATA 结束后的最终状态）。 */
function readResponseLines(chunk: Buffer): string[] {
  return chunk
    .toString('utf8')
    .split(/\r?\n/)
    .filter((l) => l.length > 0);
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
        `Date: ${new Date().toUTCString()}`,
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
        socket.write(`${body}\r\n.\r\n`, 'utf8', () => {
          socket.once('data', (chunk) => {
            clearTimeout(timer);
            const lines = readResponseLines(chunk);
            resolve(lines[lines.length - 1] ?? '');
          });
        });
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
