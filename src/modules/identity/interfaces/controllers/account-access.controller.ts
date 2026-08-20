/**
 * AccountAccessController（interfaces 层；接口清单 §4：GET /api/auth/session、
 * POST /api/auth/logout、降级期间的能力白名单判定）。
 *
 * 职责（identity README）：会话视图（本人资料 + 账号访问状态）与降级访问判定。
 *
 * - GET /api/auth/session → 本人资料快照 + 账号访问状态（降级/剩余窗口）；
 *   permissions/workspace 属平台层会话门面组合点，identity 不产出不越界；
 * - 降级期间逐请求判定：请求方可携带能力类别（category），服务端按白名单
 *   （PUBLIC_PAGE/OWN_BASIC_PROFILE_READ/OWN_EXISTING_DRAFT_EDIT）放行，
 *   其余一律拒绝（SRS-FAIL-001；IGF-DEGRADE-*）；
 * - 非本人/未认证主体：AUT 分面在本控制器不产生读取路径——subjectId 恒为会话主体，
 *   拒绝由会话/授权层（HTTP 401/403）先于控制器执行。
 */

import type {
  GetMyProfileQuery,
  GetMyProfileResult,
} from '../../application/queries/get-my-profile.query';
import type { GetAccountAccessQuery } from '../../application/queries/get-account-access.query';
import type { DegradationCommandCategory } from '../../domain/services/degradation.policy';
import type { ActorContext } from './profiles.controller';
import { toApiError } from '../http/error-http';
import type { ApiErrorResult } from '../http/error-http';

export interface SessionResponse {
  readonly profile: {
    readonly version: number;
    readonly studentId: string | null;
    readonly name: string | null;
    readonly email: string | null;
    readonly phone: string | null;
    readonly emailVerified: boolean;
    readonly profileComplete: boolean;
    readonly syncStatus: Record<string, string>;
  };
  readonly accountAccess: {
    readonly state: string;
    readonly degraded: boolean;
    readonly degradedSince: string | null;
    readonly remainingWindowMs: number;
  };
}

export interface AccessCheckInput {
  readonly category: string;
  readonly sessionAuthenticatedBeforeFailure: boolean;
}

export interface AccessCheckResponse {
  readonly allowed: boolean;
  readonly degraded: boolean;
  readonly reason: string | null;
}

export type AccountAccessControllerResult<T> =
  { readonly ok: true; readonly value: T } | ApiErrorResult;

export class AccountAccessController {
  constructor(
    private readonly getMyProfile: GetMyProfileQuery,
    private readonly getAccountAccess: GetAccountAccessQuery,
  ) {}

  /** GET /api/auth/session */
  async getSession(actor: ActorContext): Promise<AccountAccessControllerResult<SessionResponse>> {
    try {
      const profile = await this.getMyProfile.execute({
        subjectId: actor.subjectId,
        now: actor.now,
      });
      const access = await this.getAccountAccess.execute({
        subjectId: actor.subjectId,
        now: actor.now,
        category: 'OWN_BASIC_PROFILE_READ',
        sessionAuthenticatedBeforeFailure: true,
      });
      return { ok: true, value: toSessionResponse(profile, access) };
    } catch (error) {
      return toApiError(error);
    }
  }

  /** 降级期间能力判定（SRS-FAIL-001 服务端逐请求判定；能力类别由会话/网关传入） */
  async checkAccess(
    actor: ActorContext,
    input: AccessCheckInput,
  ): Promise<AccountAccessControllerResult<AccessCheckResponse>> {
    try {
      const access = await this.getAccountAccess.execute({
        subjectId: actor.subjectId,
        now: actor.now,
        category: input.category as DegradationCommandCategory | 'PROTECTED_BUSINESS',
        sessionAuthenticatedBeforeFailure: input.sessionAuthenticatedBeforeFailure,
      });
      return {
        ok: true,
        value: {
          allowed: access.whitelistAllowed,
          degraded: access.degraded,
          reason: access.reason,
        },
      };
    } catch (error) {
      return toApiError(error);
    }
  }
}

function toSessionResponse(
  profile: GetMyProfileResult,
  access: {
    readonly state: string;
    readonly degraded: boolean;
    readonly degradedSince: Date | null;
    readonly remainingWindowMs: number;
  },
): SessionResponse {
  return {
    profile: {
      version: profile.version,
      studentId: profile.fields.studentId ?? null,
      name: profile.fields.name ?? null,
      email: profile.fields.email ?? null,
      phone: profile.fields.phone ?? null,
      emailVerified: profile.emailVerified,
      profileComplete: profile.profileComplete,
      syncStatus: Object.fromEntries(
        Object.entries(profile.syncStatus).map(([field, status]) => [field, status.state]),
      ),
    },
    accountAccess: {
      state: access.state,
      degraded: access.degraded,
      degradedSince: access.degradedSince ? access.degradedSince.toISOString() : null,
      remainingWindowMs: access.remainingWindowMs,
    },
  };
}
