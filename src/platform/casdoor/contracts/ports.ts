/**
 * Casdoor 统一适配端口（CAS-READ-001~007、CAS-WR-002~013、CAS-REC-005~009）。
 *
 * 领域模块和后台任务只依赖本文件声明的端口；具体 HTTP/SDK 响应结构只在
 * infrastructure 层出现（ADR-009 §2.1）。
 */

import type { ExternalResult, EvidenceRef } from './external-result';
import type {
  CapabilityFingerprint,
  CasdoorGroup,
  CasdoorIdentityBinding,
  CasdoorOrganization,
  CasdoorUser,
  GroupMapping,
  GroupStableRef,
  OrganizationMapping,
  Page,
  SubjectGroupRelation,
  SubjectMapping,
} from './types';

export const CASDOOR_READ_PORT = Symbol('CASDOOR_READ_PORT');
export const CASDOOR_WRITE_PORT = Symbol('CASDOOR_WRITE_PORT');
export const CASDOOR_MAPPING_STORE = Symbol('CASDOOR_MAPPING_STORE');
export const CASDOOR_CLOCK = Symbol('CASDOOR_CLOCK');

export interface ClockPort {
  now(): Date;
}

export interface ReadAccountStateRequest {
  readonly externalUserId: string;
  readonly reason: string;
  readonly freshness: 'REAL_TIME' | 'OBSERVATION';
  readonly trackingId: string;
}

export interface ReadGroupMembersRequest {
  readonly ref: GroupStableRef;
  readonly reason: string;
  readonly freshness: 'REAL_TIME' | 'OBSERVATION';
  readonly trackingId: string;
}

export interface ReadGroupsRequest {
  readonly scope: string;
  readonly cursor?: string;
  readonly limit: number;
  readonly trackingId: string;
}

export interface ReconcileEnumerateRequest {
  readonly runId: string;
  readonly scope: string;
  readonly watermark: string;
  readonly cursor?: string;
  readonly limit: number;
  readonly trackingId: string;
}

export interface ReconcileEnumeratePage<T> {
  readonly items: readonly T[];
  readonly nextCursor: string | null;
  readonly hasMore: boolean;
  readonly evidence: EvidenceRef;
}

/**
 * 传输中立只读端口。
 */
export interface CasdoorReadPort {
  getCapabilityFingerprint(request: {
    instance: string;
    expectedBaseline: string;
    trackingId: string;
  }): Promise<ExternalResult<CapabilityFingerprint>>;

  resolveCurrentIdentity(request: {
    tokenClaims: Readonly<Record<string, unknown>>;
    expectedIssuer: string;
    expectedAudience: string;
    trackingId: string;
  }): Promise<ExternalResult<CasdoorIdentityBinding>>;

  getAccountState(request: ReadAccountStateRequest): Promise<ExternalResult<CasdoorUser>>;

  getOrganization(request: {
    owner: string;
    trackingId: string;
  }): Promise<ExternalResult<CasdoorOrganization>>;

  getGroupByRef(request: {
    ref: GroupStableRef;
    trackingId: string;
  }): Promise<ExternalResult<CasdoorGroup>>;

  getUserGroups(request: {
    externalUserId: string;
    trackingId: string;
  }): Promise<ExternalResult<readonly CasdoorGroup[]>>;

  listGroups(request: ReadGroupsRequest): Promise<ExternalResult<Page<CasdoorGroup>>>;

  enumerateAccounts(
    request: ReconcileEnumerateRequest,
  ): Promise<ExternalResult<ReconcileEnumeratePage<CasdoorUser>>>;

  enumerateGroups(
    request: ReconcileEnumerateRequest,
  ): Promise<ExternalResult<ReconcileEnumeratePage<CasdoorGroup>>>;

  enumerateRelations(
    request: ReconcileEnumerateRequest,
  ): Promise<
    ExternalResult<
      ReconcileEnumeratePage<{ externalUserId: string; groups: readonly GroupStableRef[] }>
    >
  >;
}

/**
 * 传输中立写端口：每个写操作带 requestId，供幂等与审计。
 */
export interface CasdoorWritePort {
  addGroupMembers(request: {
    ref: GroupStableRef;
    userIds: readonly string[];
    requestId: string;
    trackingId: string;
  }): Promise<ExternalResult<void>>;

  removeGroupMembers(request: {
    ref: GroupStableRef;
    userIds: readonly string[];
    requestId: string;
    trackingId: string;
  }): Promise<ExternalResult<void>>;

  updateUser(request: {
    externalUserId: string;
    patch: Readonly<Record<string, unknown>>;
    requestId: string;
    trackingId: string;
  }): Promise<ExternalResult<void>>;

  readbackGroupMembers(request: {
    ref: GroupStableRef;
    requestId: string;
    trackingId: string;
  }): Promise<ExternalResult<readonly string[]>>;

  readbackUser(request: {
    externalUserId: string;
    requestId: string;
    trackingId: string;
  }): Promise<ExternalResult<CasdoorUser>>;
}

export interface MappingStore {
  saveSubjectMapping(mapping: SubjectMapping): Promise<void>;
  findSubjectMapping(localSubjectId: string): Promise<SubjectMapping | null>;
  findSubjectMappingByExternal(externalSubjectId: string): Promise<SubjectMapping | null>;
  listSubjectMappings(): Promise<SubjectMapping[]>;
  saveOrganizationMapping(mapping: OrganizationMapping): Promise<void>;
  findOrganizationMapping(localPlatformId: string): Promise<OrganizationMapping | null>;
  saveGroupMapping(mapping: GroupMapping): Promise<void>;
  findGroupMappingByLocal(localObjectRef: string): Promise<GroupMapping | null>;
  findGroupMappingByExternal(ref: GroupStableRef): Promise<GroupMapping | null>;
  listGroupMappings(): Promise<GroupMapping[]>;
  saveRelation(relation: SubjectGroupRelation): Promise<void>;
  listRelationsBySubject(localSubjectId: string): Promise<SubjectGroupRelation[]>;
  listAllRelations(): Promise<SubjectGroupRelation[]>;
}
