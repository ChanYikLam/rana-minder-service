/**
 * 本人资料查询用例（IFC-QRY-003/IFC-SM-002；API-AUTH-002 GET /api/auth/profile）。
 *
 * 回源权威聚合（IFC-QRY-001）：资料门状态、字段值、邮箱验证状态与每个白名单字段的
 * 同步状态（syncStatus）一并返回；不从通知或缓存推断当前状态。
 *
 * 边界：仅查询本人资料（scope 强制 subjectId=当前主体）；非本人拒绝在接口层完成。
 */

import { EditableProfileField } from '../../domain/models/profile-field';
import type { ProfileRepository } from '../ports/profile-repository.port';
import type { ProfileSyncIntentRepository } from '../ports/profile-sync-intent-repository.port';
import type { DegradationPolicy } from '../../domain/services/degradation.policy';
import type { AccountAccessRepository } from '../ports/account-access-repository.port';
import { identityErrors } from '../errors';

export interface GetMyProfileInput {
  readonly subjectId: string;
  readonly now: Date;
}

export interface SyncStatusEntry {
  readonly field: EditableProfileField;
  readonly state: string;
  readonly targetVersion: number | null;
  readonly attempts: number;
  readonly retryAt: Date | null;
  readonly conflictVersion: number | null;
  readonly resolvedAt: Date | null;
}

export interface GetMyProfileResult {
  readonly subjectId: string;
  readonly version: number;
  readonly fields: Record<string, string | undefined>;
  readonly emailVerified: boolean;
  readonly verifiedEmail: string | null;
  readonly pendingEmail: string | null;
  readonly gateState: string;
  readonly restrictions: readonly { scopeKey: string; reason: string; since: Date }[];
  readonly syncStatus: Record<string, SyncStatusEntry>;
  readonly profileComplete: boolean;
  readonly degraded: boolean;
  readonly degradedSince: Date | null;
  readonly remainingWindowMs: number;
}

export interface GetMyProfileQuery {
  execute(input: GetMyProfileInput): Promise<GetMyProfileResult>;
}

export class DefaultGetMyProfileQuery implements GetMyProfileQuery {
  constructor(
    private readonly profileRepository: ProfileRepository,
    private readonly syncIntentRepository: ProfileSyncIntentRepository,
    private readonly accountRepository: AccountAccessRepository,
    private readonly degradation: DegradationPolicy,
  ) {}

  async execute(input: GetMyProfileInput): Promise<GetMyProfileResult> {
    const snapshot = await this.profileRepository.load(input.subjectId);
    if (!snapshot) {
      throw identityErrors.notFound('资料');
    }

    const account = await this.accountRepository.load(input.subjectId);

    const syncStatus: Record<string, SyncStatusEntry> = {};
    for (const field of Object.values(EditableProfileField)) {
      const intent = await this.syncIntentRepository.load(input.subjectId, field);
      syncStatus[field] = intent
        ? {
            field,
            state: intent.state,
            targetVersion: intent.targetVersion,
            attempts: intent.attempts,
            retryAt: intent.retryAt,
            conflictVersion: intent.conflictVersion,
            resolvedAt: intent.resolvedAt,
          }
        : {
            field,
            state: 'none',
            targetVersion: null,
            attempts: 0,
            retryAt: null,
            conflictVersion: null,
            resolvedAt: null,
          };
    }

    const degradedSince = account?.degradedSince ?? null;
    const remainingWindowMs = degradedSince
      ? this.degradation.remainingWindowMs(degradedSince, input.now)
      : 0;

    return {
      subjectId: snapshot.subjectId,
      version: snapshot.version,
      fields: { ...snapshot.fields },
      emailVerified: snapshot.emailVerified,
      verifiedEmail: snapshot.verifiedEmail,
      pendingEmail: snapshot.pendingEmail,
      gateState: snapshot.gateState,
      restrictions: snapshot.restrictions.map((r) => ({
        scopeKey: r.scopeKey,
        reason: r.reason,
        since: r.since,
      })),
      syncStatus,
      profileComplete: snapshot.gateState !== 'PENDING_COMPLETION',
      degraded: account?.state === 'UNVERIFIABLE',
      degradedSince,
      remainingWindowMs,
    };
  }
}