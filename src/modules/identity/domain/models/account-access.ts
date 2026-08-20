/**
 * IDN-001 账号访问聚合根（SRS-SM-IDN-001）。
 *
 * 承载：账号访问状态、降级区间、会话撤销版本、最近可信观测、状态版本与历史事件。
 * 领域规则归属 DefaultAccountAccessStateMachine；本聚合只应用机器判定并发出领域事件。
 *
 * 不变量（IDN-008/GOV-009）：禁用/删除立即终止会话并撤销全部当前权限，完整保留本地历史；
 * 恢复不自动恢复已结束业务/已撤销任务/历史角色。
 */

import type { DomainEvent } from './domain-event';
import {
  AccountAccessState,
  AccountAccessEvent,
  type AccountAccessStateMachine,
  type AccountAccessTransitionResult,
  type WhitelistVerdict,
} from '../state-machines/account-access.state-machine';

export interface AccountAccessSnapshot {
  readonly subjectId: string;
  readonly state: AccountAccessState;
  readonly stateVersion: number;
  readonly degradedSince: Date | null;
  readonly lastTrustedObservationAt: Date | null;
  readonly sessionRevokeVersion: number;
}

export type AccountAccessEventName =
  | 'ACCOUNT_DISABLED'
  | 'ACCOUNT_DELETED'
  | 'ACCOUNT_DEGRADED'
  | 'ACCOUNT_RECOVERED'
  | 'ACCOUNT_REENABLED'
  | 'ACCOUNT_WHITELIST_OPERATION';

export type AccountAccessDomainEvent = DomainEvent<
  AccountAccessEventName,
  { subjectId: string; fromState: AccountAccessState; toState: AccountAccessState; reason: string }
>;

export type AccountAccessSource = 'CASDOOR_EVENT' | 'RECONCILIATION' | 'READBACK' | 'SYSTEM';

export class AccountAccess {
  private readonly events_: AccountAccessDomainEvent[] = [];
  private lastResult: AccountAccessTransitionResult | null = null;

  private constructor(private snapshot: AccountAccessSnapshot) {}

  static fromSnapshot(snapshot: AccountAccessSnapshot): AccountAccess {
    return new AccountAccess(snapshot);
  }

  /** 首次登录初始化：新账号从有效状态开始（IDN-001 初始事实） */
  static create(subjectId: string, now: Date): AccountAccess {
    const snapshot: AccountAccessSnapshot = {
      subjectId,
      state: AccountAccessState.ACTIVE,
      stateVersion: 0,
      degradedSince: null,
      lastTrustedObservationAt: now,
      sessionRevokeVersion: 0,
    };
    return new AccountAccess(snapshot);
  }

  get subjectId(): string {
    return this.snapshot.subjectId;
  }

  get state(): AccountAccessState {
    return this.snapshot.state;
  }

  get stateVersion(): number {
    return this.snapshot.stateVersion;
  }

  get degradedSince(): Date | null {
    return this.snapshot.degradedSince;
  }

  get sessionRevokeVersion(): number {
    return this.snapshot.sessionRevokeVersion;
  }

  get events(): readonly AccountAccessDomainEvent[] {
    return this.events_;
  }

  /** 最近一次转换结果（供应用层驱动会话/重新认证处置） */
  get lastTransitionResult(): AccountAccessTransitionResult | null {
    return this.lastResult;
  }

  toSnapshot(): AccountAccessSnapshot {
    return { ...this.snapshot };
  }

  private applyTransition(
    machineEvent: AccountAccessEvent,
    result: AccountAccessTransitionResult,
    reason: string,
    now: Date,
  ): boolean {
    if (!result.allowed) {
      return false;
    }
    const fromState = this.snapshot.state;
    this.snapshot = {
      ...this.snapshot,
      state: result.nextState,
      stateVersion: this.snapshot.stateVersion + 1,
      degradedSince: result.nextState === AccountAccessState.UNVERIFIABLE ? now : null,
      sessionRevokeVersion: result.sessionRevoke
        ? this.snapshot.sessionRevokeVersion + 1
        : this.snapshot.sessionRevokeVersion,
      lastTrustedObservationAt:
        result.nextState === AccountAccessState.UNVERIFIABLE
          ? this.snapshot.lastTrustedObservationAt
          : now,
    };
    this.lastResult = result;
    this.events_.push({
      type: eventNameFor(machineEvent, fromState, result.nextState),
      occurredAt: now,
      payload: { subjectId: this.subjectId, fromState, toState: result.nextState, reason },
    });
    return true;
  }

  /** R001 有效→禁用（事件/对账） */
  disable(machine: AccountAccessStateMachine, reason: string, now: Date): boolean {
    const result = machine.transition({
      event: AccountAccessEvent.CASDOOR_DISABLED,
      currentState: this.state,
    });
    return this.applyTransition(AccountAccessEvent.CASDOOR_DISABLED, result, reason, now);
  }

  /** R002 有效→删除（事件/对账） */
  delete(machine: AccountAccessStateMachine, reason: string, now: Date): boolean {
    const result = machine.transition({
      event: AccountAccessEvent.CASDOOR_DELETED,
      currentState: this.state,
    });
    return this.applyTransition(AccountAccessEvent.CASDOOR_DELETED, result, reason, now);
  }

  /** R003 有效→暂不可确认（故障判定） */
  enterDegradation(machine: AccountAccessStateMachine, reason: string, now: Date): boolean {
    const result = machine.transition({
      event: AccountAccessEvent.CASDOOR_UNVERIFIABLE,
      currentState: this.state,
    });
    return this.applyTransition(AccountAccessEvent.CASDOOR_UNVERIFIABLE, result, reason, now);
  }

  /** R004 暂不可确认→回读收口（有效/禁用/删除按回读结果） */
  recoverFromReadback(
    machine: AccountAccessStateMachine,
    readbackState: AccountAccessState,
    reason: string,
    now: Date,
  ): boolean {
    const result = machine.transition({
      event: AccountAccessEvent.READBACK_RECOVERED,
      currentState: this.state,
      readbackState,
    });
    return this.applyTransition(AccountAccessEvent.READBACK_RECOVERED, result, reason, now);
  }

  /** R005 禁用→有效（恢复并重新登录） */
  reenable(machine: AccountAccessStateMachine, reason: string, now: Date): boolean {
    const result = machine.transition({
      event: AccountAccessEvent.ACCOUNT_REENABLED,
      currentState: this.state,
    });
    return this.applyTransition(AccountAccessEvent.ACCOUNT_REENABLED, result, reason, now);
  }

  /** R006 降级窗口内白名单操作（自环） */
  allowWhitelistOperation(
    machine: AccountAccessStateMachine,
    verdict: WhitelistVerdict,
    reason: string,
    now: Date,
  ): boolean {
    const result = machine.transition({
      event: AccountAccessEvent.WHITELIST_OPERATION,
      currentState: this.state,
      whitelistVerdict: verdict,
    });
    return this.applyTransition(AccountAccessEvent.WHITELIST_OPERATION, result, reason, now);
  }
}

function eventNameFor(
  machineEvent: AccountAccessEvent,
  fromState: AccountAccessState,
  toState: AccountAccessState,
): AccountAccessEventName {
  if (machineEvent === AccountAccessEvent.WHITELIST_OPERATION || fromState === toState) {
    return 'ACCOUNT_WHITELIST_OPERATION';
  }
  switch (toState) {
    case AccountAccessState.DISABLED:
      return 'ACCOUNT_DISABLED';
    case AccountAccessState.DELETED:
      return 'ACCOUNT_DELETED';
    case AccountAccessState.UNVERIFIABLE:
      return 'ACCOUNT_DEGRADED';
    case AccountAccessState.ACTIVE:
      return fromState === AccountAccessState.DISABLED ? 'ACCOUNT_REENABLED' : 'ACCOUNT_RECOVERED';
  }
}