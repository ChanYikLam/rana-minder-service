/**
 * IDN-003 资料同步意图实体（SRS-SM-IDN-003；DATA-CAS-002/003）。
 *
 * 一条同步意图 = 用户 + 字段 + 目标版本（唯一）；承载修改前值、目标值、读回值、
 * 冲突版本、尝试次数、下次重试与 24 小时连续失败起点。
 *
 * 规则归属：DefaultProfileSyncStateMachine 与 DefaultProfileSyncPolicy；
 * 本实体应用判定并记录收口事实。本地立即生效 + 可见最终一致（IDN-020）。
 */

import type { DomainEvent } from './domain-event';
import type { EditableProfileField } from './profile-field';
import {
  ProfileSyncState,
  ProfileSyncEvent,
  type ProfileSyncStateMachine,
  type ProfileSyncTransitionInput,
} from '../state-machines/profile-sync.state-machine';
import type { ProfileSyncPolicy, ReadbackDecision } from '../services/profile-sync.policy';

export interface ProfileSyncIntentSnapshot {
  readonly id: string;
  readonly subjectId: string;
  readonly field: EditableProfileField;
  readonly targetVersion: number;
  readonly priorValue: string | null;
  readonly targetValue: string;
  readonly readbackValue: string | null;
  readonly state: ProfileSyncState;
  readonly conflictVersion: number | null;
  readonly attempts: number;
  readonly retryAt: Date | null;
  readonly failedSince: Date | null;
  readonly resolvedAt: Date | null;
  readonly createdAt: Date;
}

export type ProfileSyncDomainEvent = DomainEvent<
  'SYNC_STATE_TRANSITIONED' | 'SYNC_CONFLICT_DETECTED' | 'SYNC_ROLLED_BACK',
  {
    subjectId: string;
    field: EditableProfileField;
    targetVersion: number;
    fromState: ProfileSyncState;
    toState: ProfileSyncState;
  }
>;

export class ProfileSyncIntent {
  private readonly events_: ProfileSyncDomainEvent[] = [];

  private constructor(private snapshot: ProfileSyncIntentSnapshot) {}

  static fromSnapshot(snapshot: ProfileSyncIntentSnapshot): ProfileSyncIntent {
    return new ProfileSyncIntent(snapshot);
  }

  /** 新建同步意图（R001 本地保存白名单字段合法新值：原子保存本地新值 + 同步意图） */
  static create(input: {
    id: string;
    subjectId: string;
    field: EditableProfileField;
    targetVersion: number;
    priorValue: string | null;
    targetValue: string;
    now: Date;
  }): ProfileSyncIntent {
    const snapshot: ProfileSyncIntentSnapshot = {
      id: input.id,
      subjectId: input.subjectId,
      field: input.field,
      targetVersion: input.targetVersion,
      priorValue: input.priorValue,
      targetValue: input.targetValue,
      readbackValue: null,
      state: ProfileSyncState.PENDING_SYNC,
      conflictVersion: null,
      attempts: 0,
      retryAt: null,
      failedSince: null,
      resolvedAt: null,
      createdAt: input.now,
    };
    return new ProfileSyncIntent(snapshot);
  }

  get state(): ProfileSyncState {
    return this.snapshot.state;
  }

  get attempts(): number {
    return this.snapshot.attempts;
  }

  get failedSince(): Date | null {
    return this.snapshot.failedSince;
  }

  get events(): readonly ProfileSyncDomainEvent[] {
    return this.events_;
  }

  toSnapshot(): ProfileSyncIntentSnapshot {
    return { ...this.snapshot };
  }

  /** R002 启动写入：记录尝试；不得覆盖更晚本地版本 */
  startWrite(machine: ProfileSyncStateMachine, isCurrentVersion: boolean, now: Date): boolean {
    return this.advance(
      machine,
      {
        event: ProfileSyncEvent.START_WRITE,
        currentState: this.snapshot.state,
        isCurrentVersion,
      },
      now,
    );
  }

  /** R003 写入并回读确认目标值 */
  confirmTarget(machine: ProfileSyncStateMachine, isCurrentVersion: boolean, now: Date): boolean {
    const ok = this.advance(
      machine,
      {
        event: ProfileSyncEvent.WRITE_CONFIRMED,
        currentState: this.snapshot.state,
        isCurrentVersion,
      },
      now,
    );
    if (ok) {
      this.snapshot = { ...this.snapshot, resolvedAt: now, failedSince: null };
    }
    return ok;
  }

  /** R004 临时失败且未满 24 小时：登记尝试与退避，冻结连续失败起点 */
  recordTransientFailure(
    machine: ProfileSyncStateMachine,
    policy: ProfileSyncPolicy,
    isCurrentVersion: boolean,
    now: Date,
  ): boolean {
    const ok = this.advance(
      machine,
      {
        event: ProfileSyncEvent.TRANSIENT_FAILURE,
        currentState: this.snapshot.state,
        isCurrentVersion,
      },
      now,
    );
    if (ok) {
      const attempts = this.snapshot.attempts + 1;
      this.snapshot = {
        ...this.snapshot,
        attempts,
        retryAt: new Date(now.getTime() + policy.nextRetryDelayMs(attempts)),
        failedSince: this.snapshot.failedSince ?? now,
      };
    }
    return ok;
  }

  /** R005 连续 24 小时仍失败：冻结盲目写重试并进入强制读回 */
  freezeAfter24Hours(
    machine: ProfileSyncStateMachine,
    isCurrentVersion: boolean,
    now: Date,
  ): boolean {
    return this.advance(
      machine,
      {
        event: ProfileSyncEvent.TWENTY_FOUR_HOUR_FAILURE,
        currentState: this.snapshot.state,
        isCurrentVersion,
      },
      now,
    );
  }

  /** R006/R007/R008/R011 读回收口（决策来自 ProfileSyncPolicy.decideReadback） */
  applyReadback(
    machine: ProfileSyncStateMachine,
    decision: ReadbackDecision,
    readbackValue: string | null,
    isCurrentVersion: boolean,
    now: Date,
  ): boolean {
    const eventByDecision: Partial<Record<ReadbackDecision, ProfileSyncEvent>> = {
      SYNCED: ProfileSyncEvent.READBACK_TARGET,
      ROLLED_BACK: ProfileSyncEvent.READBACK_ORIGINAL,
      CONFLICT: ProfileSyncEvent.READBACK_THIRD_VALUE,
      CONVERGE_AUTHORITATIVE: ProfileSyncEvent.READBACK_AUTHORITATIVE_THIRD,
    };
    const event = eventByDecision[decision];
    if (!event) {
      return false; // READBACK_UNTRUSTWORTHY：保持待读回核验，不推进
    }
    const ok = this.advance(
      machine,
      {
        event,
        currentState: this.snapshot.state,
        isCurrentVersion,
        editableField: decision === 'CONFLICT',
        conflictVersionMatches: true,
      },
      now,
    );
    if (ok) {
      this.snapshot = {
        ...this.snapshot,
        readbackValue,
        conflictVersion: decision === 'CONFLICT' ? this.snapshot.targetVersion : null,
        resolvedAt: now,
        failedSince: null,
      };
    }
    return ok;
  }

  /** R009 本人选择保留本地目标值：创建新同步意图由应用层完成，此处关闭旧冲突窗口 */
  keepLocal(machine: ProfileSyncStateMachine, snapshotStillMatches: boolean, now: Date): boolean {
    return this.advance(
      machine,
      {
        event: ProfileSyncEvent.USER_CHOICE_KEEP_LOCAL,
        currentState: this.snapshot.state,
        conflictVersionMatches: true,
        readbackStillMatchesSnapshot: snapshotStillMatches,
      },
      now,
    );
  }

  /** R010 本人选择接受 Casdoor 当前值 */
  acceptCasdoor(machine: ProfileSyncStateMachine, snapshotStillMatches: boolean, now: Date): boolean {
    const ok = this.advance(
      machine,
      {
        event: ProfileSyncEvent.USER_CHOICE_ACCEPT_CASDOOR,
        currentState: this.snapshot.state,
        conflictVersionMatches: true,
        readbackStillMatchesSnapshot: snapshotStillMatches,
      },
      now,
    );
    if (ok) {
      this.snapshot = { ...this.snapshot, resolvedAt: now, failedSince: null };
    }
    return ok;
  }

  /** R012 有权人工处理并重新发起同步（必须创建新版本和新幂等键） */
  manualRetry(
    machine: ProfileSyncStateMachine,
    target: Extract<ProfileSyncState, 'PENDING_SYNC' | 'MANUAL_INTERVENTION'>,
    now: Date,
  ): boolean {
    return this.advance(
      machine,
      {
        event: ProfileSyncEvent.MANUAL_RETRY,
        currentState: this.snapshot.state,
        retryTarget: target,
      },
      now,
    );
  }

  private advance(
    machine: ProfileSyncStateMachine,
    input: ProfileSyncTransitionInput,
    now: Date,
  ): boolean {
    const result = machine.transition(input);
    if (!result.allowed) {
      return false;
    }
    const fromState = this.snapshot.state;
    this.snapshot = { ...this.snapshot, state: result.nextState };
    this.events_.push({
      type:
        result.nextState === ProfileSyncState.CONFLICT_PENDING_USER_CHOICE
          ? 'SYNC_CONFLICT_DETECTED'
          : result.nextState === ProfileSyncState.ROLLED_BACK
            ? 'SYNC_ROLLED_BACK'
            : 'SYNC_STATE_TRANSITIONED',
      occurredAt: now,
      payload: {
        subjectId: this.snapshot.subjectId,
        field: this.snapshot.field,
        targetVersion: this.snapshot.targetVersion,
        fromState,
        toState: result.nextState,
      },
    });
    return true;
  }
}