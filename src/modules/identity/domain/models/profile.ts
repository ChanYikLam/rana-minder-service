/**
 * IDN-002 资料聚合根（SRS-SM-IDN-002/003；IDN-002/006/010/013/014/015/019）。
 *
 * 承载：三层资料模型中平台公共补充资料层（IDN-013）——白名单字段（email/phone/college/
 * grade）、邮箱验证、资料门派生缓存、分范围限制集合与乐观锁版本。
 * 社团成员资料/招新报名资料层不在此聚合，由对应领域对象经资料快照引用（IDN-013、FORM-004）。
 *
 * 规则归属：字段目录（models/profile-field）、ProfileWriteGateStateMachine 与
 * ProfileGatePolicy；本聚合应用判定并发出领域事件。姓名/学号只读权威字段不在本聚合可写范围
 * （经姓名更正流程或 Casdoor 可信变更更新，IDN-016/IDN-017）。
 */

import type { DomainEvent } from './domain-event';
import {
  EditableProfileField,
  isEditableProfileField,
  type EditableProfileField as EditableFieldName,
} from './profile-field';
import { Email } from './email';
import {
  ProfileWriteGateState,
  ProfileWriteGateEvent,
  type ProfileWriteGateStateMachine,
} from '../state-machines/profile-write-gate.state-machine';
import type { ProfileGatePolicy, ScopeRestriction } from '../services/profile-gate.policy';

export interface ProfileFields {
  email?: string;
  phone?: string;
  college?: string;
  grade?: string;
}

export interface ProfileSnapshot {
  readonly subjectId: string;
  readonly fields: ProfileFields;
  readonly emailVerified: boolean;
  readonly verifiedEmail: string | null;
  readonly pendingEmail: string | null;
  readonly version: number;
  readonly gateState: ProfileWriteGateState;
  readonly restrictions: readonly ScopeRestriction[];
}

export type ProfileDomainEvent = DomainEvent<
  'PROFILE_SAVED' | 'EMAIL_VERIFIED' | 'EMAIL_VERIFICATION_REQUESTED' | 'GATE_TRANSITIONED',
  {
    subjectId: string;
    version: number;
    // PROFILE_SAVED：本次变更的字段与同步意图字段
    changedFields?: readonly EditableFieldName[];
    pendingSyncFields?: readonly EditableFieldName[];
    // GATE_TRANSITIONED：资料门新旧状态
    fromGate?: ProfileWriteGateState;
    toGate?: ProfileWriteGateState;
  }
>;

export interface SaveEditableFieldsInput {
  readonly fields: Partial<ProfileFields>;
  readonly expectedVersion: number;
  readonly now: Date;
}

export class Profile {
  private readonly events_: ProfileDomainEvent[] = [];

  private constructor(private snapshot: ProfileSnapshot) {}

  static fromSnapshot(snapshot: ProfileSnapshot): Profile {
    return new Profile(snapshot);
  }

  get subjectId(): string {
    return this.snapshot.subjectId;
  }

  get version(): number {
    return this.snapshot.version;
  }

  get gateState(): ProfileWriteGateState {
    return this.snapshot.gateState;
  }

  get emailVerified(): boolean {
    return this.snapshot.emailVerified;
  }

  get verifiedEmail(): string | null {
    return this.snapshot.verifiedEmail;
  }

  get pendingEmail(): string | null {
    return this.snapshot.pendingEmail;
  }

  get restrictions(): readonly ScopeRestriction[] {
    return this.snapshot.restrictions;
  }

  get events(): readonly ProfileDomainEvent[] {
    return this.events_;
  }

  toSnapshot(): ProfileSnapshot {
    return {
      ...this.snapshot,
      fields: { ...this.snapshot.fields },
      restrictions: [...this.snapshot.restrictions],
    };
  }

  /** 保存可编辑白名单字段（IDN-002/006/010）：乐观锁校验 + 只允许白名单字段；本地立即生效 */
  saveEditableFields(input: SaveEditableFieldsInput): boolean {
    if (input.expectedVersion !== this.snapshot.version) {
      return false; // 409 IFC-ERR-008 版本冲突，由应用层映射
    }
    const changed: EditableFieldName[] = [];
    for (const key of Object.keys(input.fields) as Array<keyof ProfileFields>) {
      if (!isEditableProfileField(key)) {
        return false; // 只读权威字段（name/studentId）或未知字段一律拒绝
      }
      const next = input.fields[key];
      if (next === undefined) {
        continue;
      }
      if (key === EditableProfileField.EMAIL) {
        // 邮箱修改不直接替换当前有效邮箱：旧邮箱保持有效、新邮箱进入待验证（IDN-011）
        this.snapshot = {
          ...this.snapshot,
          pendingEmail: Email.of(next as string).toString(),
        };
      } else {
        this.snapshot = { ...this.snapshot, fields: { ...this.snapshot.fields, [key]: next } };
      }
      changed.push(key);
    }
    if (changed.length === 0) {
      return false;
    }
    this.snapshot = { ...this.snapshot, version: this.snapshot.version + 1 };
    this.events_.push({
      type: 'PROFILE_SAVED',
      occurredAt: input.now,
      payload: {
        subjectId: this.subjectId,
        version: this.snapshot.version,
        changedFields: changed,
        pendingSyncFields: changed,
      },
    });
    return true;
  }

  /** 登记待验证邮箱（R003 发送/重发验证邮件前置）：版本 +1 并发出请求事件 */
  requestEmailVerification(
    machine: ProfileWriteGateStateMachine,
    email: string,
    now: Date,
  ): boolean {
    const gate = machine.transition({
      event: ProfileWriteGateEvent.SEND_VERIFICATION_EMAIL,
      currentState: this.snapshot.gateState,
      emailValid: true,
      resendAllowed: true,
      mailCapable: true,
    });
    if (!gate.allowed) {
      return false;
    }
    const normalized = Email.of(email).toString();
    this.snapshot = {
      ...this.snapshot,
      pendingEmail: normalized,
      version: this.snapshot.version + 1,
    };
    this.events_.push({
      type: 'EMAIL_VERIFICATION_REQUESTED',
      occurredAt: now,
      payload: { subjectId: this.subjectId, version: this.snapshot.version },
    });
    return true;
  }

  /** R005 验证链接成功：替换旧有效邮箱并重新计算全部资料门（单次令牌判定在应用层） */
  markEmailVerified(
    machine: ProfileWriteGateStateMachine,
    policy: ProfileGatePolicy,
    now: Date,
  ): boolean {
    if (this.snapshot.pendingEmail === null) {
      return false;
    }
    const gate = machine.transition({
      event: ProfileWriteGateEvent.VERIFICATION_SUCCESS,
      currentState: this.snapshot.gateState,
      derivedNextState: policy.deriveGate({
        platformMissingFields: [],
        emailVerified: true,
        restrictions: this.snapshot.restrictions,
      }),
    });
    if (!gate.allowed) {
      return false;
    }
    const newEmail = this.snapshot.pendingEmail;
    this.snapshot = {
      ...this.snapshot,
      emailVerified: true,
      verifiedEmail: newEmail,
      pendingEmail: null,
      fields: { ...this.snapshot.fields, email: newEmail },
      gateState: gate.nextState,
      version: this.snapshot.version + 1,
    };
    this.events_.push({
      type: 'EMAIL_VERIFIED',
      occurredAt: now,
      payload: { subjectId: this.subjectId, version: this.snapshot.version },
    });
    return true;
  }

  /** 新增分范围限制（R007）：作用域键唯一，多限制并集生效 */
  addScopeRestriction(
    machine: ProfileWriteGateStateMachine,
    policy: ProfileGatePolicy,
    restriction: ScopeRestriction,
    now: Date,
  ): boolean {
    if (policy.isScopeRestricted(this.snapshot.restrictions, restriction.scopeKey)) {
      return false; // 作用域键唯一
    }
    const gate = machine.transition({
      event: ProfileWriteGateEvent.SCOPE_REQUIREMENT_MISSING,
      currentState: this.snapshot.gateState,
    });
    if (!gate.allowed) {
      return false;
    }
    const fromGate = this.snapshot.gateState;
    this.snapshot = {
      ...this.snapshot,
      restrictions: [...this.snapshot.restrictions, restriction],
      gateState: gate.nextState,
      version: this.snapshot.version + 1,
    };
    this.emitGateTransition(fromGate, gate.nextState, now);
    return true;
  }

  /** 解除单个范围限制（R008）：原子关闭已满足的限制，不得扩大其他范围权限 */
  releaseScopeRestriction(
    machine: ProfileWriteGateStateMachine,
    policy: ProfileGatePolicy,
    scopeKey: string,
    now: Date,
  ): boolean {
    if (!policy.isScopeRestricted(this.snapshot.restrictions, scopeKey)) {
      return false;
    }
    const remaining = policy.remainingRestrictions(this.snapshot.restrictions, scopeKey);
    const derived = policy.deriveGate({
      platformMissingFields: [],
      emailVerified: this.snapshot.emailVerified,
      restrictions: remaining,
    });
    const gate = machine.transition({
      event: ProfileWriteGateEvent.SCOPE_REQUIREMENT_SATISFIED,
      currentState: this.snapshot.gateState,
      scopeSatisfied: true,
      derivedNextState: derived,
    });
    if (!gate.allowed) {
      return false;
    }
    const fromGate = this.snapshot.gateState;
    this.snapshot = {
      ...this.snapshot,
      restrictions: remaining,
      gateState: gate.nextState,
      version: this.snapshot.version + 1,
    };
    this.emitGateTransition(fromGate, gate.nextState, now);
    return true;
  }

  /** 按当前事实重算资料门（IDN-010 原子重算；R006 新必填字段生效收敛） */
  recomputeGate(
    machine: ProfileWriteGateStateMachine,
    policy: ProfileGatePolicy,
    platformMissingFields: readonly string[],
    now: Date,
  ): boolean {
    const derived = policy.deriveGate({
      platformMissingFields,
      emailVerified: this.snapshot.emailVerified,
      restrictions: this.snapshot.restrictions,
    });
    if (derived === this.snapshot.gateState) {
      return false;
    }
    const gate = machine.transition({
      event:
        derived === ProfileWriteGateState.PENDING_COMPLETION
          ? ProfileWriteGateEvent.NEW_REQUIRED_FIELD_EFFECTIVE
          : ProfileWriteGateEvent.SAVE_PLATFORM_PROFILE,
      currentState: this.snapshot.gateState,
      derivedNextState: derived,
      fieldEffective: true,
      valueMissing: platformMissingFields.length > 0,
    });
    if (!gate.allowed) {
      return false;
    }
    const fromGate = this.snapshot.gateState;
    this.snapshot = {
      ...this.snapshot,
      gateState: gate.nextState,
      version: this.snapshot.version + 1,
    };
    this.events_.push({
      type: 'GATE_TRANSITIONED',
      occurredAt: now,
      payload: {
        subjectId: this.subjectId,
        version: this.snapshot.version,
        fromGate,
        toGate: gate.nextState,
      },
    });
    return true;
  }

  /** R009 本人保留本地目标值：创建新同步版本（字段不变，版本 +1 使新同步意图成为当前版本，IDN-007） */
  bumpVersionForConflictRetry(_now: Date): void {
    this.snapshot = { ...this.snapshot, version: this.snapshot.version + 1 };
  }

  /** R010 本人接受 Casdoor 当前值：本地采用经本人确认的外部值并重算资料门（邮箱同时落已验证） */
  adoptExternalValue(
    machine: ProfileWriteGateStateMachine,
    policy: ProfileGatePolicy,
    field: EditableFieldName,
    value: string,
    now: Date,
  ): boolean {
    if (!isEditableProfileField(field)) {
      return false; // 只读权威字段不经本人选择（R008 守卫）
    }
    const emailVerified =
      field === EditableProfileField.EMAIL ? true : this.snapshot.emailVerified;
    this.snapshot = {
      ...this.snapshot,
      emailVerified,
      ...(field === EditableProfileField.EMAIL
        ? { verifiedEmail: value, pendingEmail: null }
        : {}),
      fields: { ...this.snapshot.fields, [field]: value },
    };

    const derived = policy.deriveGate({
      platformMissingFields: [],
      emailVerified,
      restrictions: this.snapshot.restrictions,
    });
    if (derived !== this.snapshot.gateState) {
      const gate = machine.transition({
        event:
          this.snapshot.gateState === ProfileWriteGateState.PENDING_EMAIL_VERIFICATION
            ? ProfileWriteGateEvent.VERIFICATION_SUCCESS
            : ProfileWriteGateEvent.SAVE_PLATFORM_PROFILE,
        currentState: this.snapshot.gateState,
        derivedNextState: derived,
      });
      if (!gate.allowed) {
        return false;
      }
      const fromGate = this.snapshot.gateState;
      this.snapshot = { ...this.snapshot, gateState: gate.nextState };
      this.emitGateTransition(fromGate, gate.nextState, now);
    }

    this.snapshot = { ...this.snapshot, version: this.snapshot.version + 1 };
    this.events_.push({
      type: 'PROFILE_SAVED',
      occurredAt: now,
      payload: {
        subjectId: this.subjectId,
        version: this.snapshot.version,
        changedFields: [field],
        pendingSyncFields: [],
      },
    });
    return true;
  }

  private emitGateTransition(
    fromGate: ProfileWriteGateState,
    toGate: ProfileWriteGateState,
    now: Date,
  ): void {
    this.events_.push({
      type: 'GATE_TRANSITIONED',
      occurredAt: now,
      payload: {
        subjectId: this.subjectId,
        version: this.snapshot.version,
        fromGate,
        toGate,
      },
    });
  }
}