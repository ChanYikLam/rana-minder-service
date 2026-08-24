/**
 * CasdoorGroupPort 真实 HTTP 适配器（#68 / ADR-009 §2.1、CAS-WR-*）。
 *
 * 与 adapters/casdoor/http-casdoor.adapter.ts 同一约定：Node 内置 fetch、
 * Basic client 凭据仅存服务端、超时中止、错误脱敏（不回显密钥/完整响应）。
 *
 * 端点映射（默认值按 Casdoor v3.108 REST 形态给出；部署前须按实例核对，
 * 可用 options 覆盖——未验证能力不写成已冻结接口，CAS-CAP-004）：
 * - GET  {api}/get-group?owner=&name=        → Group 元数据（含成员 id 列表字段）
 * - GET  {api}/get-groups?owner=<org>        → 组织内 Group 目录
 * - GET  {api}/get-group-users?id=<groupPk>  → Group 成员实况（读回权威源）
 * - POST {memberAddPath}/{memberRemovePath}  → 成员增删（body: {groupPk, userId}）
 *
 * 写后定向读回（CAS-WR-006/007）：writeMembership 不把 HTTP 2xx 当成功——
 * 必须回读目标 Group 实况并确认主体已在/已不在，才返回 success；回读失败或
 * 结果不符返回 unknown，由关系命令状态机按 IFC-ERR-013 处置（先回读再重试）。
 */

import type {
  CasdoorGroupInfo,
  CasdoorGroupPort,
  CasdoorReadback,
  CasdoorWriteResult,
} from '../../application/ports';
import type { GroupStableRef } from '../../domain/types';
import { toRedactedErrorSummary } from '../../../../adapters/redaction';

export interface HttpCasdoorGroupAdapterOptions {
  readonly endpoint: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly organization: string;
  /** Group 成员列表字段名（不同版本为 users/memberIds），默认 users */
  readonly membersField?: string;
  /** 成员增删端点路径；默认按 v3.108 形态，部署前须核对 */
  readonly memberAddPath?: string;
  readonly memberRemovePath?: string;
  readonly fetchFn?: typeof fetch;
  readonly now?: () => Date;
  readonly timeoutMs?: number;
}

interface RawGroup {
  id?: string;
  owner?: string;
  name?: string;
  displayName?: string;
  parentId?: string;
  users?: Array<{ id?: string; name?: string }>;
  [key: string]: unknown;
}

export class HttpCasdoorGroupAdapter implements CasdoorGroupPort {
  private readonly base: string;
  private readonly authHeader: string;
  private readonly organization: string;
  private readonly membersField: string;
  private readonly memberAddPath: string;
  private readonly memberRemovePath: string;
  private readonly fetchFn: typeof fetch;
  private readonly now: () => Date;
  private readonly timeoutMs: number;

  constructor(options: HttpCasdoorGroupAdapterOptions) {
    this.base = `${options.endpoint.replace(/\/+$/, '')}/api`;
    this.authHeader = `Basic ${Buffer.from(
      `${options.clientId}:${options.clientSecret}`,
      'utf8',
    ).toString('base64')}`;
    this.organization = options.organization;
    this.membersField = options.membersField ?? 'users';
    this.memberAddPath = options.memberAddPath ?? '/add-user-to-group';
    this.memberRemovePath = options.memberRemovePath ?? '/remove-user-from-group';
    this.fetchFn = options.fetchFn ?? globalThis.fetch.bind(globalThis);
    this.now = options.now ?? (() => new Date());
    this.timeoutMs = options.timeoutMs ?? 10_000;
  }

  private async request(
    path: string,
    init: RequestInit,
  ): Promise<{ ok: boolean; status: number; data: unknown }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchFn(`${this.base}${path}`, {
        ...init,
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          ...(init.headers as Record<string, string> | undefined),
          Authorization: this.authHeader,
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
      return {
        ok: false,
        status: 0,
        data: {
          __error:
            err instanceof Error && err.name === 'AbortError'
              ? 'timeout'
              : toRedactedErrorSummary(err),
        },
      };
    } finally {
      clearTimeout(timer);
    }
  }

  private mapGroup(raw: RawGroup, opts?: { readable?: boolean }): CasdoorGroupInfo | null {
    if (typeof raw?.id !== 'string' || typeof raw?.name !== 'string') return null;
    const parentOwner = typeof raw.parentId === 'string' ? raw.parentId.split('/')[0] : null;
    const parentName =
      typeof raw.parentId === 'string' ? raw.parentId.split('/').slice(1).join('/') : null;
    const memberIds = Array.isArray(raw[this.membersField])
      ? (raw[this.membersField] as Array<{ id?: string }>)
          .map((u) => u.id)
          .filter((id): id is string => typeof id === 'string')
      : [];
    // 用途推断（ORG-011/012）：Casdoor Group 无原生用途语义，精确用途以本地
    // GroupMappingRegistry 登记为准；目录展示兜底为 department（保守缺省）。
    return {
      stableId: raw.id,
      ref: { owner: typeof raw.owner === 'string' ? raw.owner : this.organization, name: raw.name },
      displayName: typeof raw.displayName === 'string' ? raw.displayName : raw.name,
      path:
        typeof raw.parentId === 'string' ? `/${String(raw.parentId)}/${raw.name}` : `/${raw.name}`,
      parentRef:
        parentOwner !== null && parentName !== null && parentName.length > 0
          ? { owner: parentOwner, name: parentName }
          : null,
      memberIds,
      readable: opts?.readable ?? true,
      deleted: false,
    };
  }

  async listGroups(): Promise<CasdoorGroupInfo[]> {
    const { ok, status, data } = await this.request(
      `/get-groups?owner=${encodeURIComponent(this.organization)}`,
      { method: 'GET' },
    );
    // 401/403 → 凭据失权/权限回收：目录整体不可读。上抛而非返回空目录，
    // 否则会把 no_access 误报为「组织内无 Group」；调用方据此可触发失权处置。
    if (status === 401 || status === 403) {
      throw new Error(`casdoor list-groups forbidden (status=${status})`);
    }
    // 网络/超时/5xx → 瞬时故障：上抛交由上层重试，严禁伪装成空目录。
    if (!ok) {
      throw new Error(`casdoor list-groups failed (status=${status || 'network'})`);
    }
    // 200 但 body 非数组：瞬时空/畸形响应，不能当作「确实没有 Group」。
    if (!Array.isArray(data)) {
      throw new Error(`casdoor list-groups returned invalid body (status=${status})`);
    }
    return (data as RawGroup[])
      .map((g) => this.mapGroup(g))
      .filter((g): g is CasdoorGroupInfo => g !== null);
  }

  async getGroupByRef(ref: GroupStableRef): Promise<CasdoorGroupInfo | null> {
    const { ok, status, data } = await this.request(
      `/get-group?owner=${encodeURIComponent(ref.owner)}&name=${encodeURIComponent(ref.name)}`,
      { method: 'GET' },
    );
    // 只有 404 才是「Group 确实不存在」；500/超时等瞬时故障必须上抛，
    // 严禁被对账固化为 deleted 异常（ORG-026）。
    if (status === 404) return null;
    // 401/403 → 凭据失权/权限回收：Group 存在但当前凭据不可读。
    // 返回 readable:false（而非上抛）是对账 no_access 分支的数据源，
    // 否则 HTTP 适配器下 no_access 永远无法触发（死代码）。
    if (status === 401 || status === 403) {
      const raw = typeof data === 'object' && data !== null ? (data as RawGroup) : undefined;
      const mapped = raw ? this.mapGroup(raw, { readable: false }) : null;
      if (mapped !== null) return mapped;
      // 响应未携带可用元数据：仍构造一个最小化 Group 以标记失权，
      // 避免因拿不到元数据而丢失 no_access 信号。
      return {
        stableId: ref.name,
        ref,
        displayName: ref.name,
        path: `/${ref.name}`,
        parentRef: null,
        memberIds: [],
        readable: false,
        deleted: false,
      };
    }
    if (!ok) {
      throw new Error(`casdoor get-group failed (status=${status || 'network'})`);
    }
    // 200 但空/非法 body：瞬时空响应，不能当作 deleted（null 会被对账
    // 固化为 deleted 异常）；上抛为瞬时故障交由上层重试。
    if (typeof data !== 'object' || data === null) {
      throw new Error(`casdoor get-group returned empty body (status=${status})`);
    }
    return this.mapGroup(data as RawGroup);
  }

  async getGroupMembers(ref: GroupStableRef): Promise<readonly string[]> {
    const group = await this.getGroupByRef(ref);
    if (group === null) return [];
    // readable=false：凭据失权/权限回收，无法读取成员实况。
    // 严禁回落空 []（会把「不可读」误报为「无成员」，进而使 buildSteps 的
    // present=false 误判 original.result=failed 走错补偿路径）；上抛由上层处置。
    if (group.readable === false) {
      throw new Error(`casdoor group not readable: ${ref.owner}/${ref.name}`);
    }
    const { ok, status, data } = await this.request(
      `/get-group-users?id=${encodeURIComponent(group.stableId)}`,
      { method: 'GET' },
    );
    if (ok && status >= 200 && status < 300) {
      if (!Array.isArray(data)) return group.memberIds;
      return (data as Array<{ id?: string }>)
        .map((u) => u.id)
        .filter((id): id is string => typeof id === 'string');
    }
    // 读失败 fail-closed：回落 Group 元数据内嵌成员（仍拿不到则空集），
    // 不把"读不到"伪装成"无人"（失权检测交由对账 no_access 分支）。
    // 复用顶部已取到的 group，避免重复 fetch 同一 Group。
    return group.memberIds;
  }

  async writeMembership(input: {
    ref: GroupStableRef;
    subjectId: string;
    action: 'add' | 'remove';
    requestId: string;
  }): Promise<CasdoorWriteResult> {
    let group: CasdoorGroupInfo | null;
    try {
      group = await this.getGroupByRef(input.ref);
    } catch {
      // 读取 Group 瞬时故障（非 404）→ 可重试 unknown，而非误判为 not found
      return {
        requestId: input.requestId,
        outcome: 'unknown',
        error: 'casdoor get-group failed (transient)',
      };
    }
    if (group === null) {
      return {
        requestId: input.requestId,
        outcome: 'failure',
        error: `group not found: ${input.ref.owner}/${input.ref.name}`,
      };
    }
    const path = input.action === 'add' ? this.memberAddPath : this.memberRemovePath;
    const { ok, status } = await this.request(path, {
      method: 'POST',
      body: JSON.stringify({ id: group.stableId, userId: input.subjectId }),
    });
    if (!ok) {
      const retryable = status === 0 || status >= 500 || status === 429;
      return {
        requestId: input.requestId,
        outcome: retryable ? 'unknown' : 'failure',
        error: `casdoor write rejected (status=${status || 'network'})`,
      };
    }
    // 写后定向读回（CAS-WR-006/007）：不以 2xx 宣称成功。
    // 读回必须走严格路径：只有真正读到权威成员实况才允许确认。
    // 若沿用 fail-closed 的 getGroupMembers/readback，读失败会被置空 []，
    // 使 remove 的 !members.includes(subjectId) 恒真而误报成功（本修复点）。
    let confirmed = false;
    try {
      const {
        ok: ro,
        status: rs,
        data: rd,
      } = await this.request(`/get-group-users?id=${encodeURIComponent(group.stableId)}`, {
        method: 'GET',
      });
      if (ro && rs >= 200 && rs < 300 && Array.isArray(rd)) {
        const members = (rd as Array<{ id?: string }>)
          .map((u) => u.id)
          .filter((id): id is string => typeof id === 'string');
        confirmed =
          input.action === 'add'
            ? members.includes(input.subjectId)
            : !members.includes(input.subjectId);
      }
      // 非 2xx 或响应非数组 → 读失败，不确认
    } catch {
      confirmed = false;
    }
    return confirmed
      ? { requestId: input.requestId, outcome: 'success' }
      : {
          requestId: input.requestId,
          outcome: 'unknown',
          error: 'write accepted but readback not confirming',
        };
  }

  async readback(refs: readonly GroupStableRef[]): Promise<CasdoorReadback> {
    const membersByGroup: Record<string, readonly string[]> = {};
    for (const ref of refs) {
      const key = `${ref.owner}/${ref.name}`;
      // 不再吞掉异常置空：瞬时故障/失权须向上传播，由对账/补偿依据
      // 异常而非空成员集判定，避免把「读失败」误报为「确实无人」。
      membersByGroup[key] = await this.getGroupMembers(ref);
    }
    return { membersByGroup };
  }
}
