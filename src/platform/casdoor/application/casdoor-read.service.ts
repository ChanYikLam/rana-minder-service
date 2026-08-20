/**
 * Casdoor 统一读服务（CAS-READ-001~007）。
 *
 * 只返回规范化外部结果与稳定映射事实，不生成角色/权限/业务结论。
 */

import { Inject, Injectable } from '@nestjs/common';

import {
  CASDOOR_CLOCK,
  CASDOOR_READ_PORT,
  CASDOOR_MAPPING_STORE,
  type CasdoorReadPort,
  type ClockPort,
  type MappingStore,
} from '../contracts/ports';
import type { ExternalResult } from '../contracts/external-result';
import { notFound, notUnique, trustedCurrent } from '../contracts/external-result';
import type {
  CapabilityFingerprint,
  CasdoorGroup,
  CasdoorIdentityBinding,
  CasdoorUser,
  GroupStableRef,
  Page,
  SubjectMapping,
} from '../contracts/types';

@Injectable()
export class CasdoorReadService {
  constructor(
    @Inject(CASDOOR_READ_PORT)
    private readonly read: CasdoorReadPort,
    @Inject(CASDOOR_MAPPING_STORE)
    private readonly mappings: MappingStore,
    @Inject(CASDOOR_CLOCK)
    private readonly clock: ClockPort,
  ) {}

  getCapabilityFingerprint(request: {
    instance: string;
    expectedBaseline: string;
    trackingId: string;
  }): Promise<ExternalResult<CapabilityFingerprint>> {
    return this.read.getCapabilityFingerprint(request);
  }

  async resolveAndBindCurrentIdentity(request: {
    tokenClaims: Readonly<Record<string, unknown>>;
    expectedIssuer: string;
    expectedAudience: string;
    localSubjectId: string;
    trackingId: string;
  }): Promise<ExternalResult<SubjectMapping>> {
    const external = await this.read.resolveCurrentIdentity(request);
    if (external.status !== 'TRUSTED_CURRENT' || external.value === null) {
      return {
        status: external.status,
        value: null,
        evidence: external.evidence,
        error: external.error,
      };
    }

    const binding: CasdoorIdentityBinding = external.value;
    const existing = await this.mappings.findSubjectMapping(request.localSubjectId);
    const existingByExternal = await this.mappings.findSubjectMappingByExternal(
      binding.externalUserId,
    );

    if (
      existing &&
      existingByExternal &&
      existing.localSubjectId !== existingByExternal.localSubjectId
    ) {
      return notUnique(
        { observedAt: this.clock.now().toISOString(), attemptId: request.trackingId },
        '同一外部身份已绑定其他本地主体，不能自动合并',
      );
    }

    const now = this.clock.now().toISOString();
    const mapping: SubjectMapping = {
      localSubjectId: request.localSubjectId,
      externalSubjectId: binding.externalUserId,
      instance: binding.issuer,
      status: 'BOUND',
      firstVerifiedAt: existing?.firstVerifiedAt ?? now,
      lastVerifiedAt: now,
      history: existing?.history ?? [],
    };
    await this.mappings.saveSubjectMapping(mapping);
    return trustedCurrent(mapping, { observedAt: now, attemptId: request.trackingId });
  }

  readAccountState(request: {
    externalUserId: string;
    reason: string;
    freshness: 'REAL_TIME' | 'OBSERVATION';
    trackingId: string;
  }): Promise<ExternalResult<CasdoorUser>> {
    return this.read.getAccountState({
      externalUserId: request.externalUserId,
      reason: request.reason,
      freshness: request.freshness,
      trackingId: request.trackingId,
    });
  }

  readGroup(request: {
    ref: GroupStableRef;
    trackingId: string;
  }): Promise<ExternalResult<CasdoorGroup>> {
    return this.read.getGroupByRef(request);
  }

  readUserGroups(request: {
    externalUserId: string;
    trackingId: string;
  }): Promise<ExternalResult<readonly CasdoorGroup[]>> {
    return this.read.getUserGroups(request);
  }

  listGroups(request: {
    scope: string;
    cursor?: string;
    limit: number;
    trackingId: string;
  }): Promise<ExternalResult<Page<CasdoorGroup>>> {
    return this.read.listGroups(request);
  }

  /** 读回当前主体 Group 关系并登记本地观测（CAS-MAP-004）。 */
  async readAndStoreUserGroups(request: {
    localSubjectId: string;
    externalUserId: string;
    trackingId: string;
  }): Promise<ExternalResult<readonly CasdoorGroup[]>> {
    const result = await this.read.getUserGroups({
      externalUserId: request.externalUserId,
      trackingId: request.trackingId,
    });
    if (result.status === 'TRUSTED_CURRENT' && result.value !== null) {
      const now = this.clock.now().toISOString();
      for (const group of result.value) {
        await this.mappings.saveRelation({
          localSubjectId: request.localSubjectId,
          groupRef: group.ref,
          current: true,
          observedAt: now,
          source: 'LIVE_READ',
        });
      }
    }
    return result;
  }

  /** 验证重新认证证据（CAS-READ-006）：10 分钟新鲜度由调用方/策略目录声明。 */
  verifyReauthentication(input: {
    readonly authTime?: string;
    readonly requiredFreshnessMs: number;
    readonly mfaRequired: boolean;
    readonly mfaVerified: boolean;
    readonly subjectId?: string;
    readonly bindingSubjectId?: string;
    readonly trackingId: string;
  }): ExternalResult<{ ok: boolean }> {
    if (input.subjectId !== input.bindingSubjectId) {
      return notFound(
        { observedAt: this.clock.now().toISOString(), attemptId: input.trackingId },
        {
          kind: 'NOT_FOUND',
          code: 'CAS-ERR_REAUTH_SUBJECT',
          message: '重新认证证据不属于当前主体',
          retryable: false,
          trackingId: input.trackingId,
        },
      );
    }
    if (input.authTime === undefined) {
      return notFound(
        { observedAt: this.clock.now().toISOString(), attemptId: input.trackingId },
        {
          kind: 'NOT_FOUND',
          code: 'CAS-ERR_NO_AUTH_TIME',
          message: '缺少 auth_time 证据',
          retryable: false,
          trackingId: input.trackingId,
        },
      );
    }
    const authAt = Date.parse(input.authTime);
    if (Number.isNaN(authAt) || this.clock.now().getTime() - authAt > input.requiredFreshnessMs) {
      return notFound(
        { observedAt: this.clock.now().toISOString(), attemptId: input.trackingId },
        {
          kind: 'NOT_FOUND',
          code: 'CAS-ERR_REAUTH_STALE',
          message: '重新认证证据已过期',
          retryable: false,
          trackingId: input.trackingId,
        },
      );
    }
    // CAS-READ-006：拒绝来自未来的 auth_time（时钟偏移或伪造），避免被误判为“新鲜”
    // 而通过。容忍 5 分钟时钟偏移，避免正常分布式时钟抖动被误拒。
    const FUTURE_SKEW_TOLERANCE_MS = 5 * 60 * 1000;
    if (authAt - this.clock.now().getTime() > FUTURE_SKEW_TOLERANCE_MS) {
      return notFound(
        { observedAt: this.clock.now().toISOString(), attemptId: input.trackingId },
        {
          kind: 'NOT_FOUND',
          code: 'CAS-ERR_REAUTH_FUTURE',
          message: '重新认证证据时间戳来自未来，拒绝',
          retryable: false,
          trackingId: input.trackingId,
        },
      );
    }
    if (input.mfaRequired && !input.mfaVerified) {
      return notFound(
        { observedAt: this.clock.now().toISOString(), attemptId: input.trackingId },
        {
          kind: 'NOT_FOUND',
          code: 'CAS-ERR_REAUTH_MFA',
          message: '缺少所需 MFA 证据',
          retryable: false,
          trackingId: input.trackingId,
        },
      );
    }
    return trustedCurrent(
      { ok: true },
      { observedAt: this.clock.now().toISOString(), attemptId: input.trackingId },
    );
  }
}
