/**
 * 账号访问与降级窗口查询用例（IFC-QRY-005；IDN-009、SRS-FAIL-001）。
 *
 * 返回权威账号状态、降级起点、剩余窗口与白名单能力判定结果（服务端逐请求判定，
 * 客户端不得复用旧判定）；账号禁用/删除时会话立即失效（IDN-008/GOV-009）。
 */

import type { AccountAccessRepository } from '../ports/account-access-repository.port';
import type {
  DegradationPolicy,
  DegradationCommandCategory,
} from '../../domain/services/degradation.policy';
import { identityErrors } from '../errors';

export interface GetAccountAccessInput {
  readonly subjectId: string;
  readonly now: Date;
  readonly category: DegradationCommandCategory | 'PROTECTED_BUSINESS';
  readonly sessionAuthenticatedBeforeFailure: boolean;
}

export interface GetAccountAccessResult {
  readonly state: string;
  readonly degraded: boolean;
  readonly degradedSince: Date | null;
  readonly remainingWindowMs: number;
  readonly withinWindow: boolean;
  readonly whitelistAllowed: boolean;
  readonly reason: string | null;
}

export interface GetAccountAccessQuery {
  execute(input: GetAccountAccessInput): Promise<GetAccountAccessResult>;
}

export class DefaultGetAccountAccessQuery implements GetAccountAccessQuery {
  constructor(
    private readonly accountRepository: AccountAccessRepository,
    private readonly degradation: DegradationPolicy,
  ) {}

  async execute(input: GetAccountAccessInput): Promise<GetAccountAccessResult> {
    const snapshot = await this.accountRepository.load(input.subjectId);
    if (!snapshot) {
      throw identityErrors.notFound('账号状态');
    }

    if (snapshot.state === 'DISABLED' || snapshot.state === 'DELETED') {
      return {
        state: snapshot.state,
        degraded: false,
        degradedSince: null,
        remainingWindowMs: 0,
        withinWindow: false,
        whitelistAllowed: false,
        reason: snapshot.state === 'DISABLED' ? '账号已被禁用' : '账号已被删除',
      };
    }

    const verdict =
      snapshot.state === 'UNVERIFIABLE' && snapshot.degradedSince
        ? this.degradation.evaluate({
            degradedSince: snapshot.degradedSince,
            now: input.now,
            sessionAuthenticatedBeforeFailure: input.sessionAuthenticatedBeforeFailure,
            category: input.category,
          })
        : {
            allowed: true,
            remainingMs: 0,
            withinWindow: false,
            reason: null,
          };

    return {
      state: snapshot.state,
      degraded: snapshot.state === 'UNVERIFIABLE',
      degradedSince: snapshot.degradedSince,
      remainingWindowMs: verdict.remainingMs,
      withinWindow: verdict.withinWindow,
      whitelistAllowed: verdict.allowed,
      reason: verdict.reason,
    };
  }
}
