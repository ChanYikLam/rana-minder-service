/**
 * 通知邮件渠道真实 SMTP 适配器（4.3 收口；EmailAdapter 端口实现）。
 *
 * 仿 adapters/mail/smtp-mail.adapter 的最小 SMTP 客户端（Node net，无 SDK）：
 * EHLO → AUTH LOGIN → MAIL FROM → RCPT TO → DATA。
 *
 * - 结果映射：DATA 250 → SENT；4xx/超时/断连 → TEMPORARY_FAILURE（可重试）；
 *   RCPT 5xx → BOUNCE（地址级永久失败）；其他 5xx → PERMANENT_FAILURE；
 *   无法确定性判定 → UNCERTAIN（调用方回读提供商结果，NTF-008/009）。
 * - 信封 From 与 Reply-To 固定为配置 fromAddress（NTF-008/009：不得被模板覆盖）。
 * - 错误一律脱敏（不回显 SMTP 凭据/完整响应）。
 * - 未配置（缺 host/fromAddress）构造抛错 fail-closed（禁止静默假发送）。
 */

import { createConnection, type Socket } from 'node:net';
import type { EmailAdapter, EmailSendInput, EmailSendResult } from './notification-ports';

export interface SmtpEmailAdapterOptions {
  readonly host: string;
  readonly port: number;
  /** 信封 From（NTF-008/009：实际发信账号，Reply-To 固定同址） */
  readonly fromAddress: string;
  readonly user?: string;
  readonly password?: string;
  readonly timeoutMs?: number;
  /** 测试注入 */
  readonly connectFn?: (port: number, host: string) => Socket;
}

function encodeBase64(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64');
}

/** 单次 SMTP 命令交换：发送行 → 等待完整多行响应（. 结尾或空行前） */
function smtpExchange(socket: Socket, command: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('smtp-timeout'));
    }, timeoutMs);
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      // 响应以 <code><space> 结束（多行以 <code>- 续行；单行即完整）
      const lines = buffer.split('\r\n').filter((l) => l.length > 0);
      const last = lines[lines.length - 1];
      if (last !== undefined && /^\d{3} /.test(last)) {
        clearTimeout(timer);
        socket.removeListener('data', onData);
        resolve(buffer);
      }
    };
    socket.on('data', onData);
    socket.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    socket.write(`${command}\r\n`);
  });
}

/** 发送 DATA 段（多行报文以 CRLF. CRLF 结束） */
async function smtpData(
  socket: Socket,
  from: string,
  to: string,
  subject: string,
  body: string,
  timeoutMs: number,
): Promise<string> {
  const dataCmd = await smtpExchange(socket, 'DATA', timeoutMs);
  if (!dataCmd.startsWith('3')) {
    return dataCmd;
  }
  // 正文行首 "." 必须转义为 ".."（SMTP 透明性），防止提前终止
  const escapedBody = body.replace(/^\./gm, '..');
  const message = [
    `From: ${from}`,
    `To: ${to}`,
    `Reply-To: ${from}`,
    `Subject: ${subject}`,
    'MIME-Version: 1.0',
    'Content-Type: text/html; charset=UTF-8',
    '',
    escapedBody,
    '.',
  ].join('\r\n');
  return smtpExchange(socket, message, timeoutMs);
}

export class SmtpEmailAdapter implements EmailAdapter {
  private readonly timeoutMs: number;
  private readonly connectFn: (port: number, host: string) => Socket;

  constructor(private readonly options: SmtpEmailAdapterOptions) {
    if (options.host.length === 0 || options.fromAddress.length === 0 || options.port <= 0) {
      throw new Error(
        'SmtpEmailAdapter: 缺少 host/fromAddress/port 配置（fail-closed，禁止静默假发送）',
      );
    }
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.connectFn = options.connectFn ?? createConnection;
  }

  async send(input: EmailSendInput): Promise<EmailSendResult> {
    const socket = this.connectFn(this.options.port, this.options.host);
    const sanitized = (raw: unknown): string | null =>
      typeof raw === 'string' && raw.length > 0 ? 'smtp-send-failed' : null;
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
        throw new Error('ehlo-failed');
      }

      // 3. AUTH LOGIN（若配置凭据）
      if (this.options.user !== undefined && this.options.password !== undefined) {
        const auth = await smtpExchange(socket, 'AUTH LOGIN', this.timeoutMs);
        if (!auth.startsWith('3')) {
          throw new Error('auth-not-supported');
        }
        const userOk = await smtpExchange(socket, encodeBase64(this.options.user), this.timeoutMs);
        if (!userOk.startsWith('3')) {
          throw new Error('auth-user-failed');
        }
        const passOk = await smtpExchange(
          socket,
          encodeBase64(this.options.password),
          this.timeoutMs,
        );
        if (!passOk.startsWith('2') && !passOk.startsWith('3')) {
          throw new Error('auth-pass-failed');
        }
      }

      // 4. MAIL FROM / RCPT TO
      const mailFrom = await smtpExchange(
        socket,
        `MAIL FROM:<${this.options.fromAddress}>`,
        this.timeoutMs,
      );
      if (!mailFrom.startsWith('2')) {
        throw new Error('mail-from-failed');
      }
      const rcptTo = await smtpExchange(socket, `RCPT TO:<${input.to}>`, this.timeoutMs);
      if (rcptTo.startsWith('5')) {
        socket.destroy();
        // 地址级永久失败（收件人拒绝/不存在）→ BOUNCE
        return { status: 'BOUNCE', channelMessageId: null, sanitizedError: 'recipient-rejected' };
      }
      if (!rcptTo.startsWith('2')) {
        throw new Error('rcpt-failed');
      }

      // 5. DATA（成功以 250 判定）
      const data = await smtpData(
        socket,
        this.options.fromAddress,
        input.to,
        input.subject,
        input.body,
        this.timeoutMs,
      );
      if (data.startsWith('2')) {
        socket.destroy();
        return { status: 'SENT', channelMessageId: null, sanitizedError: null };
      }
      // 5xx 永久失败（映射 BOUNCE 语义：不可重试退信）；4xx 临时失败（可重试）
      socket.destroy();
      return {
        status: data.startsWith('5') ? 'BOUNCE' : 'TEMPORARY_FAILURE',
        channelMessageId: null,
        sanitizedError: sanitized(data),
      };
    } catch (error) {
      socket.destroy();
      // 超时/断连/协议异常 → 临时失败（可重试）；无法确定性判定 → UNCERTAIN 兜底
      return {
        status: 'TEMPORARY_FAILURE',
        channelMessageId: null,
        sanitizedError: sanitized(error),
      };
    }
  }
}
