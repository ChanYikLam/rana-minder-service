/**
 * 开发/测试用内存 Casdoor 适配（CAS-READ-001~007、CAS-WR-002~013）。
 *
 * 仅用于模块化单体内的开发桩与单元测试；真实部署必须替换为受控的
 * Casdoor v3.108.0 HTTP/SDK 适配器，且不得把本实现写成“已存在接口”。
 */

import {
  ExternalErrorKind,
  notFound,
  trustedCurrent,
  unavailable,
  uncertain,
  type ExternalResult,
  type EvidenceRef,
} from '../contracts/external-result';
import type {
  CapabilityFingerprint,
  CasdoorGroup,
  CasdoorIdentityBinding,
  CasdoorOrganization,
  CasdoorUser,
  GroupStableRef,
  Page,
} from '../contracts/types';
import { groupRefKey } from '../contracts/types';
import type {
  CasdoorReadPort,
  CasdoorWritePort,
  ReadAccountStateRequest,
  ReadGroupsRequest,
  ReconcileEnumeratePage,
  ReconcileEnumerateRequest,
} from '../contracts/ports';

export interface InMemoryCasdoorSeed {
  readonly instance?: string;
  readonly users?: readonly CasdoorUser[];
  readonly organizations?: readonly CasdoorOrganization[];
  readonly groups?: readonly CasdoorGroup[];
}

export class InMemoryCasdoorStore implements CasdoorReadPort, CasdoorWritePort {
  readonly users = new Map<string, CasdoorUser>();
  readonly organizations = new Map<string, CasdoorOrganization>();
  readonly groups = new Map<string, CasdoorGroup>();
  readonly instance: string;

  /** 测试钩子：下一次写入/读回返回不可用或不确定。 */
  failNextWrite: 'NONE' | 'UNAVAILABLE' | 'UNCERTAIN' = 'NONE';
  /** 测试钩子：写后不立即可见，需要调用 settleWrite()。 */
  writeVisibilityDelay = false;

  constructor(seed: InMemoryCasdoorSeed = {}) {
    this.instance = seed.instance ?? 'test-instance';
    for (const u of seed.users ?? []) this.users.set(u.externalId, u);
    for (const o of seed.organizations ?? []) this.organizations.set(o.owner, o);
    for (const g of seed.groups ?? []) this.groups.set(groupRefKey(g.ref), g);
  }

  private evidence(attemptId?: string): EvidenceRef {
    return {
      observedAt: new Date().toISOString(),
      instance: this.instance,
      attemptId,
    };
  }

  private failureResult<T>(mode: InMemoryCasdoorStore['failNextWrite']): ExternalResult<T> | null {
    if (mode === 'UNAVAILABLE') return unavailable<T>(this.evidence());
    if (mode === 'UNCERTAIN') return uncertain<T>(this.evidence());
    return null;
  }

  async getCapabilityFingerprint(request: {
    instance: string;
    expectedBaseline: string;
    trackingId: string;
  }): Promise<ExternalResult<CapabilityFingerprint>> {
    const value: CapabilityFingerprint = {
      instance: request.instance,
      expectedBaseline: request.expectedBaseline,
      observedVersion: 'v3.108.0',
      capabilityEvidenceVersion: 'unverified-dev',
      verifiedAt: new Date().toISOString(),
      verified: false,
      unverifiedCapabilities: [
        'CLAIMS_USERINFO_BINDING',
        'GROUP_READ_WRITE',
        'PAGINATION_STABILITY',
        'WEBHOOK_SIGNED_EVENT',
      ],
    };
    return trustedCurrent(value, this.evidence());
  }

  async resolveCurrentIdentity(request: {
    tokenClaims: Readonly<Record<string, unknown>>;
    expectedIssuer: string;
    expectedAudience: string;
    trackingId: string;
  }): Promise<ExternalResult<CasdoorIdentityBinding>> {
    const sub = typeof request.tokenClaims['sub'] === 'string' ? request.tokenClaims['sub'] : null;
    const iss = typeof request.tokenClaims['iss'] === 'string' ? request.tokenClaims['iss'] : null;
    const aud = typeof request.tokenClaims['aud'] === 'string' ? request.tokenClaims['aud'] : null;
    const mfa = request.tokenClaims['mfa'] === true || request.tokenClaims['mfa'] === 'true';
    const authTime =
      typeof request.tokenClaims['auth_time'] === 'string'
        ? request.tokenClaims['auth_time']
        : undefined;

    if (sub === null)
      return notFound(this.evidence(), {
        kind: ExternalErrorKind.NOT_FOUND,
        code: 'CAS-ERR-NO_SUB',
        message: '令牌缺少稳定主体标识',
        retryable: false,
        trackingId: request.trackingId,
      });
    if (iss !== request.expectedIssuer || aud !== request.expectedAudience) {
      return notFound(this.evidence(), {
        kind: ExternalErrorKind.PERMISSION_DENIED,
        code: 'CAS-ERR_CLAIMS_BINDING',
        message: '签发方/受众不匹配，主体绑定失败',
        retryable: false,
        trackingId: request.trackingId,
      });
    }
    const user = this.users.get(sub);
    if (user === undefined) {
      return notFound(this.evidence());
    }
    return trustedCurrent(
      {
        externalUserId: user.externalId,
        accountState: user.state,
        issuer: iss,
        audience: aud,
        authTime,
        mfaVerified: mfa,
        claimsSummary: { sub },
      },
      this.evidence(),
    );
  }

  async getAccountState(request: ReadAccountStateRequest): Promise<ExternalResult<CasdoorUser>> {
    const user = this.users.get(request.externalUserId);
    if (user === undefined) return notFound(this.evidence());
    return trustedCurrent(user, this.evidence());
  }

  async getOrganization(request: {
    owner: string;
    trackingId: string;
  }): Promise<ExternalResult<CasdoorOrganization>> {
    const org = this.organizations.get(request.owner);
    if (org === undefined) return notFound(this.evidence());
    return trustedCurrent(org, this.evidence());
  }

  async getGroupByRef(request: {
    ref: GroupStableRef;
    trackingId: string;
  }): Promise<ExternalResult<CasdoorGroup>> {
    const group = this.groups.get(groupRefKey(request.ref));
    if (group === undefined) return notFound(this.evidence());
    return trustedCurrent(group, this.evidence());
  }

  async getUserGroups(request: {
    externalUserId: string;
    trackingId: string;
  }): Promise<ExternalResult<readonly CasdoorGroup[]>> {
    const result = [...this.groups.values()].filter((g) =>
      g.memberIds.includes(request.externalUserId),
    );
    return trustedCurrent(result, this.evidence());
  }

  async listGroups(request: ReadGroupsRequest): Promise<ExternalResult<Page<CasdoorGroup>>> {
    const all = [...this.groups.values()].sort((a, b) =>
      `${a.ref.owner}/${a.ref.name}`.localeCompare(`${b.ref.owner}/${b.ref.name}`),
    );
    const start = request.cursor ? Number.parseInt(request.cursor, 10) || 0 : 0;
    const items = all.slice(start, start + request.limit);
    const next = start + items.length < all.length ? String(start + items.length) : null;
    return trustedCurrent({ items, nextCursor: next, hasMore: next !== null }, this.evidence());
  }

  async enumerateAccounts(
    request: ReconcileEnumerateRequest,
  ): Promise<ExternalResult<ReconcileEnumeratePage<CasdoorUser>>> {
    const all = [...this.users.values()].sort((a, b) => a.externalId.localeCompare(b.externalId));
    return this.page(all, request.cursor, request.limit, request.trackingId, request.runId);
  }

  async enumerateGroups(
    request: ReconcileEnumerateRequest,
  ): Promise<ExternalResult<ReconcileEnumeratePage<CasdoorGroup>>> {
    const all = [...this.groups.values()].sort((a, b) =>
      `${a.ref.owner}/${a.ref.name}`.localeCompare(`${b.ref.owner}/${b.ref.name}`),
    );
    return this.page(all, request.cursor, request.limit, request.trackingId, request.runId);
  }

  async enumerateRelations(
    request: ReconcileEnumerateRequest,
  ): Promise<
    ExternalResult<
      ReconcileEnumeratePage<{ externalUserId: string; groups: readonly GroupStableRef[] }>
    >
  > {
    const items = [...this.users.values()]
      .sort((a, b) => a.externalId.localeCompare(b.externalId))
      .map((u) => ({
        externalUserId: u.externalId,
        groups: [...this.groups.values()]
          .filter((g) => g.memberIds.includes(u.externalId))
          .map((g) => g.ref),
      }));
    return this.page(items, request.cursor, request.limit, request.trackingId, request.runId);
  }

  private async page<T>(
    all: readonly T[],
    cursor: string | undefined,
    limit: number,
    trackingId: string,
    runId: string,
  ): Promise<ExternalResult<ReconcileEnumeratePage<T>>> {
    const start = cursor ? Number.parseInt(cursor, 10) || 0 : 0;
    const items = all.slice(start, start + limit);
    const next = start + items.length < all.length ? String(start + items.length) : null;
    return trustedCurrent(
      { items, nextCursor: next, hasMore: next !== null, evidence: this.evidence(trackingId) },
      { ...this.evidence(trackingId), runId },
    );
  }

  // -------------------------------------------------------------------------
  // 写入
  // -------------------------------------------------------------------------

  async addGroupMembers(request: {
    ref: GroupStableRef;
    userIds: readonly string[];
    requestId: string;
    trackingId: string;
  }): Promise<ExternalResult<void>> {
    const forced = this.failureResult<void>(this.failNextWrite);
    if (forced) return forced;
    const key = groupRefKey(request.ref);
    const group = this.groups.get(key);
    if (group === undefined) return notFound(this.evidence(request.requestId));
    const members = new Set(group.memberIds);
    for (const id of request.userIds) members.add(id);
    this.groups.set(key, {
      ...group,
      memberIds: [...members],
      updatedAt: new Date().toISOString(),
    });
    return trustedCurrent(undefined, this.evidence(request.requestId));
  }

  async removeGroupMembers(request: {
    ref: GroupStableRef;
    userIds: readonly string[];
    requestId: string;
    trackingId: string;
  }): Promise<ExternalResult<void>> {
    const forced = this.failureResult<void>(this.failNextWrite);
    if (forced) return forced;
    const key = groupRefKey(request.ref);
    const group = this.groups.get(key);
    if (group === undefined) return notFound(this.evidence(request.requestId));
    const remove = new Set(request.userIds);
    this.groups.set(key, {
      ...group,
      memberIds: group.memberIds.filter((id) => !remove.has(id)),
      updatedAt: new Date().toISOString(),
    });
    return trustedCurrent(undefined, this.evidence(request.requestId));
  }

  async updateUser(request: {
    externalUserId: string;
    patch: Readonly<Record<string, unknown>>;
    requestId: string;
    trackingId: string;
  }): Promise<ExternalResult<void>> {
    const forced = this.failureResult<void>(this.failNextWrite);
    if (forced) return forced;
    const user = this.users.get(request.externalUserId);
    if (user === undefined) return notFound(this.evidence(request.requestId));
    this.users.set(request.externalUserId, {
      ...user,
      ...(request.patch as Partial<CasdoorUser>),
      updatedAt: new Date().toISOString(),
    });
    return trustedCurrent(undefined, this.evidence(request.requestId));
  }

  async readbackGroupMembers(request: {
    ref: GroupStableRef;
    requestId: string;
    trackingId: string;
  }): Promise<ExternalResult<readonly string[]>> {
    const forced = this.failureResult<readonly string[]>(this.failNextWrite);
    if (forced) return forced;
    const group = this.groups.get(groupRefKey(request.ref));
    if (group === undefined) return notFound(this.evidence(request.requestId));
    return trustedCurrent(group.memberIds, this.evidence(request.requestId));
  }

  async readbackUser(request: {
    externalUserId: string;
    requestId: string;
    trackingId: string;
  }): Promise<ExternalResult<CasdoorUser>> {
    const forced = this.failureResult<CasdoorUser>(this.failNextWrite);
    if (forced) return forced;
    const user = this.users.get(request.externalUserId);
    if (user === undefined) return notFound(this.evidence(request.requestId));
    return trustedCurrent(user, this.evidence(request.requestId));
  }
}
