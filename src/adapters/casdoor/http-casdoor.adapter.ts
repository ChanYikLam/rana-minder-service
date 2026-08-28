/**
 * Casdoor 真实 HTTP 适配器（adapters/casdoor/http-casdoor.adapter.ts；T3 接线）。
 *
 * 权威依据：ADR-009（写后定向读回是唯一成功收口）、CAS-WR-006/007、
 * 接口契约-v1.0（CAS-READ-002/003、CAS-WR-*）、ADR-009 §2.9（统一脱敏/追踪）。
 *
 * 实现说明：
 * - 使用 Node 内置 fetch，不引入供应商 SDK，领域层不感知响应结构；
 * - 写（updateUser）完成后不把 HTTP 成功当作成功：必须执行写后定向读回
 *   （getUser）并以读回值验证写入学段，才返回 SUCCESS；否则返回 UNCERTAIN
 *   或 RETRYABLE_FAILURE，由调用方决定重试/补偿；
 * - 所有错误消息经脱敏（adapters/redaction），不回显密钥/令牌/完整响应；
 * - 依赖可用性由 `ADAPTERS_CASDOOR_REAL=1` 开关控制（fail-closed）。
 *
 * 由于真实 Casdoor 会话/令牌接入依赖身份模块，本适配器聚焦账号读取与资料
 * 字段写回（CAS-READ/WRITE），令牌核验/回调由身份模块承接。
 */

import type { CasdoorAdapter, CasdoorUser, CasdoorUserPatch } from './casdoor-adapter';
import type { ExternalResult } from '../../common/contracts/external-result';
import { externalSuccess, externalFailure } from '../../common/contracts/external-result';
import { randomUUID } from 'node:crypto';
import { toRedactedErrorSummary } from '../redaction';

export interface HttpCasdoorAdapterOptions {
  readonly endpoint: string;
  readonly clientId: string;
  readonly organization: string;
  readonly clientSecret: string;
  /** 注入以便单测（默认 globalThis.fetch）。 */
  readonly fetchFn?: typeof fetch;
  readonly now?: () => Date;
  readonly timeoutMs?: number;
}

function mapUser(raw: Record<string, unknown>): CasdoorUser | null {
  if (raw === null || typeof raw !== 'object') {
    return null;
  }
  const id = typeof raw['id'] === 'string' ? raw['id'] : null;
  if (!id) {
    return null;
  }
  return {
    id,
    name: typeof raw['name'] === 'string' ? raw['name'] : null,
    studentId: typeof raw['studentId'] === 'string' ? raw['studentId'] : null,
    email: typeof raw['email'] === 'string' ? raw['email'] : null,
    phone: typeof raw['phone'] === 'string' ? raw['phone'] : null,
    college: typeof raw['college'] === 'string' ? raw['college'] : null,
    grade: typeof raw['grade'] === 'string' ? raw['grade'] : null,
    // 账号状态从 isDeleted/isForbidden 推导（Casdoor 用户对象无 state 字段；
    // 原 state 字段回退导致读取恒 UNVERIFIABLE，接受邀请被误拒——联调 2026-08-27 修复）
    state:
      raw['isDeleted'] === true ? 'DELETED' : raw['isForbidden'] === true ? 'DISABLED' : 'ACTIVE',
    externalVersion:
      typeof raw['externalVersion'] === 'string'
        ? (raw['externalVersion'] as string)
        : typeof raw['updatedTime'] === 'string'
          ? (raw['updatedTime'] as string)
          : null,
  };
}

export class HttpCasdoorAdapter implements CasdoorAdapter {
  private readonly endpoint: string;
  private readonly clientId: string;
  private readonly organization: string;
  private readonly clientSecret: string;
  private readonly fetchFn: typeof fetch;
  private readonly now: () => Date;
  private readonly timeoutMs: number;

  constructor(options: HttpCasdoorAdapterOptions) {
    this.endpoint = options.endpoint.replace(/\/+$/, '');
    this.clientId = options.clientId;
    this.organization = options.organization;
    this.clientSecret = options.clientSecret;
    this.fetchFn = options.fetchFn ?? globalThis.fetch.bind(globalThis);
    this.now = options.now ?? (() => new Date());
    this.timeoutMs = options.timeoutMs ?? 10_000;
  }

  private attemptId(): string {
    return randomUUID();
  }

  private async request(
    path: string,
    init: RequestInit,
  ): Promise<{ ok: boolean; status: number; data: unknown }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchFn(`${this.endpoint}${path}`, {
        ...init,
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          ...(init.headers as Record<string, string> | undefined),
          // 服务端凭据：Basic client_id:client_secret，仅存在服务端。
          Authorization: `Basic ${Buffer.from(
            `${this.clientId}:${this.clientSecret}`,
            'utf8',
          ).toString('base64')}`,
        },
      });
      const text = await res.text();
      let data: unknown = null;
      if (text) {
        try {
          data = JSON.parse(text);
        } catch {
          data = null;
        }
      }
      return { ok: res.ok, status: res.status, data };
    } catch (err) {
      const isAbort = err instanceof Error && err.name === 'AbortError';
      return {
        ok: false,
        status: 0,
        data: { __error: isAbort ? 'timeout' : toRedactedErrorSummary(err) },
      };
    } finally {
      clearTimeout(timer);
    }
  }

  async getUser(userId: string): Promise<ExternalResult<CasdoorUser>> {
    const attemptId = this.attemptId();
    const ts = this.now();
    if (!userId) {
      return externalFailure(
        'NON_RETRYABLE',
        {
          code: 'CAS-INVALID-ARG',
          message: 'invalid user id',
          retryable: false,
          rawStatusCode: null,
        },
        attemptId,
        ts,
      );
    }
    const { ok, status, data } = await this.request(
      `/api/get-user?organization=${encodeURIComponent(this.organization)}&id=${encodeURIComponent(userId)}`,
      { method: 'GET' },
    );
    if (!ok) {
      if (status === 404) {
        return externalFailure(
          'NOT_FOUND',
          {
            code: 'CAS-NOT-FOUND',
            message: 'user not found',
            retryable: false,
            rawStatusCode: 404,
          },
          attemptId,
          ts,
        );
      }
      const errMsg =
        typeof data === 'object' && data && '__error' in (data as object)
          ? String((data as Record<string, unknown>)['__error'])
          : 'request failed';
      return externalFailure(
        'UNAVAILABLE',
        {
          code: 'CAS-UNAVAILABLE',
          message: errMsg,
          retryable: true,
          rawStatusCode: status || null,
        },
        attemptId,
        ts,
      );
    }
    // get-user 响应为 { status, data: <用户对象> }：需解包 data 再做形状映射，
    // 直接把外层 body 传入 mapUser 会因缺 id 恒判无效（联调 2026-08-27 修复）
    const bodyObj = data as { status?: string; data?: Record<string, unknown> } | null;
    const user = mapUser((bodyObj?.data ?? data) as Record<string, unknown>);
    if (!user) {
      return externalFailure(
        'UNCERTAIN',
        {
          code: 'CAS-READ-INVALID',
          message: 'unexpected response shape',
          retryable: true,
          rawStatusCode: status,
        },
        attemptId,
        ts,
      );
    }
    return externalSuccess(user, attemptId, ts);
  }

  async updateUser(userId: string, patch: CasdoorUserPatch): Promise<ExternalResult<void>> {
    const attemptId = this.attemptId();
    const ts = this.now();
    const hasAnyField =
      patch.email !== undefined ||
      patch.phone !== undefined ||
      patch.college !== undefined ||
      patch.grade !== undefined;
    if (!userId || !hasAnyField) {
      return externalFailure(
        'NON_RETRYABLE',
        {
          code: 'CAS-INVALID-ARG',
          message: 'empty patch or invalid user id',
          retryable: false,
          rawStatusCode: null,
        },
        attemptId,
        ts,
      );
    }
    // 读-改-写（联调 2026-08-27 修复）：Casdoor update-user 校验完整用户对象
    // （缺 id/owner/name/displayName 等必填字段即拒绝，部分 patch 静默无效），
    // 必须先取全量用户再合并补丁提交。
    const rawRead = await this.request(
      `/api/get-user?organization=${encodeURIComponent(this.organization)}&id=${encodeURIComponent(userId)}`,
      { method: 'GET' },
    );
    const rawBody = rawRead.data as { status?: string; data?: Record<string, unknown> } | null;
    if (!rawRead.ok || rawBody?.status !== 'ok' || !rawBody.data) {
      return externalFailure(
        'NON_RETRYABLE',
        {
          code: 'CAS-WRITE-REJECTED',
          message: 'read-before-write failed: user not found via get-user',
          retryable: false,
          rawStatusCode: rawRead.status || null,
        },
        attemptId,
        ts,
      );
    }
    // body 的 id 必须为 Casdoor 用户对象自身的 id（get-user 返回值，非 URL 的
    // org/name 定位形式；两者不同——本种子用户 id 为 ranaminder-dev__admin__fixed）。
    // 提交被改动 id 会报 "The ID is immutable."（联调 2026-08-27 修复）
    const fullUser: Record<string, unknown> = { ...rawBody.data, ...patch };
    const {
      ok,
      status,
      data: updateData,
    } = await this.request(
      `/api/update-user?organization=${encodeURIComponent(this.organization)}&id=${encodeURIComponent(userId)}`,
      { method: 'POST', body: JSON.stringify(fullUser) },
    );
    const updateBody = updateData as { status?: string; msg?: string } | null;
    if (!ok || updateBody?.status === 'error') {
      const retryable = status === 0 || status >= 500 || status === 429;
      return externalFailure(
        retryable ? 'RETRYABLE_FAILURE' : 'NON_RETRYABLE',
        {
          code: retryable ? 'CAS-WRITE-FAILED' : 'CAS-WRITE-REJECTED',
          message: `write rejected by casdoor: ${updateBody?.msg ?? `http ${status}`}`,
          retryable,
          rawStatusCode: status || null,
        },
        attemptId,
        ts,
      );
    }
    // 写后定向读回（CAS-WR-006/007）：不得以 HTTP 成功宣称成功。
    const readback = await this.getUser(userId);
    if (readback.status !== 'SUCCESS' || !readback.data) {
      return externalFailure(
        'UNCERTAIN',
        {
          code: 'CAS-WRITE-UNCERTAIN',
          message: 'write accepted but readback failed',
          retryable: true,
          rawStatusCode: null,
        },
        attemptId,
        ts,
      );
    }
    // 校验写入学段确实反映到读回值：patch 中出现的每个字段都需在读回中可见，
    // 才能宣称写后回读收口成功（CAS-WR-006/007）。用「所有字段都匹配」而非
    // 「任一匹配」，避免多字段更新时部分字段静默丢失仍被判定为成功。
    // 清空语义：patch 传空串时读回为 null/空串均视为已清空。
    const changed = [
      { patch: patch.email, read: readback.data.email },
      { patch: patch.phone, read: readback.data.phone },
      { patch: patch.college, read: readback.data.college },
      { patch: patch.grade, read: readback.data.grade },
    ]
      .filter((f): f is { patch: string; read: string | null } => f.patch !== undefined)
      .every(
        ({ patch, read }) => read === patch || (patch === '' && (read === '' || read === null)),
      );
    if (!changed) {
      return externalFailure(
        'UNCERTAIN',
        {
          code: 'CAS-WRITE-NOT-VISIBLE',
          message: 'write not visible after readback',
          retryable: true,
          rawStatusCode: null,
        },
        attemptId,
        ts,
      );
    }
    return externalSuccess(undefined, attemptId, ts);
  }
}
