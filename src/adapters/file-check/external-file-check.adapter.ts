/**
 * 文件检查外部服务真实适配器（adapters/file-check/external-file-check.adapter.ts；T3）。
 *
 * 权威依据：file-check-port.ts（FileCheckPort 契约）、IFC-FIL-002/003、
 * GOV-008（服务不可用不得超时自动放行）、NFR-003/006。
 *
 * 实现说明：
 * - 委托外部技术安全检查服务执行真实恶意内容检查，返回规范化 FileCheckResult；
 * - 服务不可用/超时返回 retryable=true 且 outcome=FAILED，领域层据此保持文件
 *   不可访问，不得超时自动通过（GOV-008）；
 * - 结果/错误脱敏，不回显原始字节内容（GOV-008）。
 *
 * 依赖可用性由 `ADAPTERS_FILECHECK_REAL=1` 开关控制（fail-closed，默认关闭）。
 */

import type {
  FileCheckPort,
  FileCheckResult,
} from '../../modules/file/infrastructure/file-check-port';
import type { FileRecord } from '../../modules/file/domain/models/file-model';
import { FileCheckOutcome } from '../../modules/file/domain/state-machines/file-state-machine';
import { toRedactedErrorSummary } from '../redaction';

export interface ExternalFileCheckAdapterOptions {
  readonly endpoint: string;
  readonly token?: string;
  readonly fetchFn?: typeof fetch;
  readonly timeoutMs?: number;
  readonly engineVersion?: string;
}

export class ExternalFileCheckAdapter implements FileCheckPort {
  static readonly ENGINE_VERSION = 'external-v1';
  private readonly endpoint: string;
  private readonly token?: string;
  private readonly fetchFn: typeof fetch;
  private readonly timeoutMs: number;
  private readonly engineVersion: string;

  constructor(options: ExternalFileCheckAdapterOptions) {
    this.endpoint = options.endpoint.replace(/\/+$/, '');
    this.token = options.token;
    this.fetchFn = options.fetchFn ?? globalThis.fetch.bind(globalThis);
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.engineVersion = options.engineVersion ?? ExternalFileCheckAdapter.ENGINE_VERSION;
  }

  async check(file: FileRecord, bytes: Uint8Array, declaredType: string): Promise<FileCheckResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchFn(`${this.endpoint}/api/file-check`, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/octet-stream',
          ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
          'X-Declared-Type': declaredType,
          'X-File-Id': file.fileId,
        },
        body: bytes,
      });
      const text = await res.text();
      let verdict: string | null = null;
      try {
        const parsed = JSON.parse(text) as { verdict?: string };
        verdict = typeof parsed?.verdict === 'string' ? parsed.verdict : null;
      } catch {
        verdict = null;
      }
      if (!res.ok) {
        return this.unavailable(`file-check-service-error:${res.status}`);
      }
      if (verdict === 'PASSED') {
        return {
          outcome: FileCheckOutcome.PASSED,
          engineVersion: this.engineVersion,
          sanitizedResult: 'external-pass',
          retryable: false,
        };
      }
      if (verdict === 'QUARANTINED') {
        return {
          outcome: FileCheckOutcome.QUARANTINED,
          engineVersion: this.engineVersion,
          sanitizedResult: 'external-quarantined',
          retryable: false,
        };
      }
      return {
        outcome: FileCheckOutcome.FAILED,
        engineVersion: this.engineVersion,
        sanitizedResult: `external-unknown-verdict:${verdict ?? 'none'}`,
        retryable: true,
      };
    } catch (err) {
      const isAbort = err instanceof Error && err.name === 'AbortError';
      return this.unavailable(isAbort ? 'file-check-timeout' : toRedactedErrorSummary(err));
    } finally {
      clearTimeout(timer);
    }
  }

  private unavailable(message: string): FileCheckResult {
    return {
      outcome: FileCheckOutcome.FAILED,
      engineVersion: this.engineVersion,
      sanitizedResult: `service-unavailable:${message}`,
      retryable: true,
    };
  }
}
