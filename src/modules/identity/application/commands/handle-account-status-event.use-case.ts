/**
 * 处理 Casdoor 账号状态事件用例（IFC-SM-001；IDN-001/008/009、CAS-EVT-*）。
 *
 * 来源：Casdoor 事件（受限刷新提示）、对账确认、回读收口、系统触发。
 * 只依据可信观测推进 IDN-001；恢复与禁用/删除事件竞争以可验证的 Casdoor
 * 当前状态为准（SRS-SM-IDN-001 守卫）。
 *
 * 边界（IDN-008/GOV-009）：禁用/删除立即终止会话并撤销权限，完整保留本地历史；
 * 恢复不自动恢复已结束业务/已撤销任务/历史角色；审计与状态转换同事务（ENG-004）。
 */

import {
  AccountAccess,
  type AccountAccessSource,
} from '../../domain/models/account-access';
import type { AccountAccessTransitionResult } from '../../domain/state-machines/account-access.state-machine';
import { AccountAccessState } from '../../domain/state-machines/account-access.state-machine';
import type { AccountAccessStateMachine } from '../../domain/state-machines/account-access.state-machine';
import type { AccountAccessRepository } from '../ports/account-access-repository.port';
import type { IdentityAuditPort } from '../ports/identity-audit.port';
import type { SessionRevocationPort } from '../ports/session-revocation.port';
import { identityErrors } from '../errors';

export type AccountStatusEvent =
  | { readonly type: 'DISABLED' }
  | { readonly type: 'DELETED' }
  | { readonly type: 'UNVERIFIABLE' }
  | { readonly type: 'READBACK'; readonly readbackState: AccountAccessState }
  | { readonly type: 'REENABLED' };

export interface HandleAccountStatusEventInput {
  readonly subjectId: string;
  readonly event: AccountStatusEvent;
  readonly source: AccountAccessSource;
  readonly reason: string;
  readonly now: Date;
  readonly actor: string;
  readonly traceId: string | null;
}

export interface HandleAccountStatusEventResult {
  readonly transition: AccountAccessTransitionResult;
  readonly stateVersion: number;
  readonly sessionRevokeVersion: number;
}

export interface HandleAccountStatusEventUseCase {
  execute(input: HandleAccountStatusEventInput): Promise<HandleAccountStatusEventResult>;
}

export class DefaultHandleAccountStatusEventUseCase implements HandleAccountStatusEventUseCase {
  constructor(
    private readonly accountRepository: AccountAccessRepository,
    private readonly machine: AccountAccessStateMachine,
    private readonly audit: IdentityAuditPort,
    private readonly sessionRevocation: SessionRevocationPort,
  ) {}

  async execute(input: HandleAccountStatusEventInput): Promise<HandleAccountStatusEventResult> {
    const snapshot = await this.accountRepository.load(input.subjectId);
    const account = snapshot ? AccountAccess.fromSnapshot(snapshot) : AccountAccess.create(input.subjectId, input.now);

    const applied = this.applyEvent(account, input);
    if (!applied) {
      throw identityErrors.preconditionFailed('当前账号状态不接受该事件（仅有效状态可禁用/删除/降级，删除后不得猜测禁用）');
    }

    const nextSnapshot = account.toSnapshot();
    if (snapshot && nextSnapshot.state === snapshot.state) {
      // 幂等：状态无变化（重复禁用/删除），只返回既有结果，不落库不重复审计
      return {
        transition: account.lastTransitionResult ?? {
          allowed: true,
          nextState: account.state,
          sessionRevoke: false,
          reauthenticationRequired: false,
          reason: null,
        },
        stateVersion: nextSnapshot.stateVersion,
        sessionRevokeVersion: nextSnapshot.sessionRevokeVersion,
      };
    }

    await this.accountRepository.save(account.toSnapshot(), account.events);
    const sessionRevoke = account.lastTransitionResult?.sessionRevoke ?? false;
    if (sessionRevoke) {
      // IDN-008：禁用/删除可信确认 → 立即终止该主体全部会话并撤销当前权限（同事务）
      await this.sessionRevocation.invalidateSessions(input.subjectId, nextSnapshot.sessionRevokeVersion);
    }
    await this.audit.record({
      type: 'ACCOUNT_ACCESS_CHANGED',
      subjectId: input.subjectId,
      occurredAt: input.now,
      actor: input.actor,
      traceId: input.traceId,
      summary: {
        event: input.event.type,
        source: input.source,
        toState: account.toSnapshot().state,
        stateVersion: account.toSnapshot().stateVersion,
        sessionRevoke,
        reason: input.reason,
      },
    });

    return {
      transition: account.lastTransitionResult ?? {
        allowed: true,
        nextState: account.state,
        sessionRevoke: false,
        reauthenticationRequired: false,
        reason: null,
      },
      stateVersion: account.stateVersion,
      sessionRevokeVersion: account.sessionRevokeVersion,
    };
  }

  private applyEvent(account: AccountAccess, input: HandleAccountStatusEventInput): boolean {
    switch (input.event.type) {
      case 'DISABLED':
        return account.disable(this.machine, input.reason, input.now);
      case 'DELETED':
        return account.delete(this.machine, input.reason, input.now);
      case 'UNVERIFIABLE':
        return account.enterDegradation(this.machine, input.reason, input.now);
      case 'READBACK':
        return account.recoverFromReadback(
          this.machine,
          input.event.readbackState,
          input.reason,
          input.now,
        );
      case 'REENABLED':
        return account.reenable(this.machine, input.reason, input.now);
    }
  }
}