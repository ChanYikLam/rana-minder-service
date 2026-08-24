/**
 * Casdoor 适配层传输中立领域类型（CAS-MAP-001~007、CAS-READ-001~007）。
 *
 * 这里只表达外部事实和稳定映射，不表达角色/权限/业务结论（CAS-GEN）。
 */

import type { EvidenceRef, ExternalResult } from './external-result';

export interface GroupStableRef {
  readonly owner: string;
  readonly name: string;
}

export function groupRefKey(ref: GroupStableRef): string {
  return `${ref.owner}\u0000${ref.name}`;
}

export function sameGroupRef(a: GroupStableRef, b: GroupStableRef): boolean {
  return a.owner === b.owner && a.name === b.name;
}

export type CasdoorAccountState = 'ACTIVE' | 'DISABLED' | 'DELETED' | 'UNKNOWN';

export interface CasdoorUser {
  readonly externalId: string;
  readonly name: string;
  readonly email?: string;
  readonly state: CasdoorAccountState;
  /** 不透明的外部版本/修改时间摘要。 */
  readonly version?: string;
  readonly updatedAt?: string;
}

export interface CasdoorOrganization {
  readonly owner: string;
  readonly displayName: string;
  readonly state: 'ACTIVE' | 'DISABLED';
  readonly version?: string;
  readonly updatedAt?: string;
}

export interface CasdoorGroup {
  readonly ref: GroupStableRef;
  readonly displayName: string;
  readonly parentRef: GroupStableRef | null;
  readonly memberIds: readonly string[];
  readonly state: 'ACTIVE' | 'DISABLED';
  readonly version?: string;
  readonly updatedAt?: string;
}

export interface CasdoorIdentityBinding {
  readonly externalUserId: string;
  readonly accountState: CasdoorAccountState;
  readonly issuer: string;
  readonly audience: string;
  readonly authTime?: string;
  readonly mfaVerified: boolean;
  readonly claimsSummary: Readonly<Record<string, string>>;
}

export interface CapabilityFingerprint {
  readonly instance: string;
  readonly expectedBaseline: string;
  readonly observedVersion: string | null;
  readonly capabilityEvidenceVersion: string;
  readonly verifiedAt: string;
  readonly verified: boolean;
  readonly unverifiedCapabilities: readonly string[];
}

export interface Page<T> {
  readonly items: readonly T[];
  readonly nextCursor: string | null;
  readonly hasMore: boolean;
}

// ---------------------------------------------------------------------------
// 映射（CAS-MAP-001~007）
// ---------------------------------------------------------------------------

export type MappingStatus = 'BOUND' | 'PENDING' | 'CONFLICT' | 'UNBOUND';

export interface SubjectMapping {
  readonly localSubjectId: string;
  readonly externalSubjectId: string;
  readonly instance: string;
  readonly status: MappingStatus;
  readonly firstVerifiedAt: string;
  readonly lastVerifiedAt: string;
  readonly history: readonly SubjectMappingEvent[];
}

export interface SubjectMappingEvent {
  readonly eventId: string;
  readonly at: string;
  readonly fromExternalSubjectId: string | null;
  readonly toExternalSubjectId: string;
  readonly reason: string;
  readonly verifiedBy: string;
}

export interface OrganizationMapping {
  readonly localPlatformId: string;
  readonly externalOwner: string;
  readonly status: MappingStatus;
  readonly lastVerifiedAt: string;
}

export interface GroupMapping {
  readonly localObjectRef: string;
  readonly externalRef: GroupStableRef;
  readonly purpose: 'SCHOOL' | 'CLUB' | 'DEPARTMENT' | 'POSITION' | 'OTHER';
  readonly status: MappingStatus;
  readonly lastVerifiedAt: string;
  readonly history: readonly GroupMappingEvent[];
}

export interface GroupMappingEvent {
  readonly eventId: string;
  readonly at: string;
  readonly fromRef: GroupStableRef | null;
  readonly toRef: GroupStableRef;
  readonly reason: string;
  readonly verifiedBy: string;
}

export interface SubjectGroupRelation {
  readonly localSubjectId: string;
  readonly groupRef: GroupStableRef;
  readonly current: boolean;
  readonly observedAt: string;
  readonly source: 'LIVE_READ' | 'WRITE_READBACK' | 'RECONCILIATION' | 'EVENT_HINT';
  readonly runId?: string;
}

// ---------------------------------------------------------------------------
// 写入（CAS-WR-001~013）
// ---------------------------------------------------------------------------

export type WriteTargetKind = 'PROFILE' | 'GROUP_MEMBERSHIP' | 'GROUP_DEFINITION';

export interface WriteCommand<T = unknown> {
  readonly commandId: string;
  readonly idempotencyKey: string;
  readonly targetKind: WriteTargetKind;
  /** 业务命令摘要，用于审计关联；不保存明文秘密/完整敏感响应。 */
  readonly commandSummary: string;
  readonly subjectId?: string;
  readonly groupRef?: GroupStableRef;
  /** 不可变目标意图：期望最终值或关系集合。 */
  readonly expectedTarget: T;
  /** 修改前可信原值/原关系快照（CAS-WR-001）。 */
  readonly originalSnapshot: T;
  readonly authorizationVersion: number;
  readonly objectVersion: number;
  readonly requestedAt: string;
}

export interface WriteAttempt {
  readonly attemptId: string;
  readonly commandId: string;
  readonly idempotencyKey: string;
  readonly startedAt: string;
  readonly finishedAt?: string;
  readonly transportResult: 'SUCCESS' | 'FAILURE' | 'UNCERTAIN';
  readonly readbackResult: ExternalResult<unknown> | null;
}

export interface CompositeWriteStep {
  readonly stepId: string;
  readonly groupRef: GroupStableRef;
  readonly action: 'ADD' | 'REMOVE';
  /** 权限层级：基础/低权限数值小，具体/高权限数值大（CAS-WR-013）。 */
  readonly privilegeRank: number;
  readonly originalMemberIds: readonly string[];
  readonly expectedMemberIds: readonly string[];
}

export interface CompositeWritePlan {
  readonly planId: string;
  readonly commandId: string;
  readonly steps: readonly CompositeWriteStep[];
  readonly deadline: string;
}

export type WriteConclusionKind =
  | 'CONFIRMED'
  | 'OLD_VALUE_STILL_PRESENT'
  | 'THIRD_VALUE'
  | 'PARTIAL_SUCCESS'
  | 'FAILED'
  | 'UNCERTAIN'
  | 'DEPENDENCY_UNAVAILABLE'
  | 'COMPENSATED'
  | 'MANUAL_INTERVENTION_REQUIRED';

export interface WriteConclusion {
  readonly kind: WriteConclusionKind;
  readonly commandId: string;
  readonly attemptIds: readonly string[];
  readonly evidence: readonly EvidenceRef[];
  readonly reason: string;
  readonly retryable: boolean;
  readonly completedAt: string;
}

// ---------------------------------------------------------------------------
// 对账（CAS-REC-005~009）
// ---------------------------------------------------------------------------

export type ReconcileStatus = 'COMPLETE_SUCCESS' | 'PARTIAL_SUCCESS' | 'FAILED' | 'UNCERTAIN';

export interface ReconcileRun {
  readonly runId: string;
  readonly scope: string;
  readonly watermark: string;
  readonly status: ReconcileStatus;
  readonly pageCount: number;
  readonly attemptCount: number;
  readonly completedAt: string;
  readonly differenceSummary: Readonly<Record<string, number>>;
  readonly evidence: readonly EvidenceRef[];
}

export interface ReconcileCandidateDifference {
  readonly runId: string;
  readonly objectType: 'ACCOUNT' | 'ORGANIZATION' | 'GROUP' | 'RELATION';
  readonly objectRef: string;
  readonly localObservation: unknown;
  readonly externalObservation: unknown;
  readonly impact: 'LOW' | 'HIGH';
  readonly verifiedByLiveRead: boolean;
}
