/**
 * 资料同步冲突本人选择用例（IFC-SM-003 R009/R010；IDN-006/007/020、PRD-OPT-045、
 * SRS-INV-015；接口清单 §4 POST /api/auth/profile/sync-conflict）。
 *
 * 规则（SRS-INV-015、SRS-FAIL-003）：
 * - 冲突仅本人可基于最新版本选择；系统与管理员不得代替用户选择；
 * - 提交前重新可信读回且与所展示冲突快照一致（读回值已变化 → 拒绝旧选择并刷新比较）；
 * - 冲突版本不匹配（存在更晚本地版本）→ 拒绝；
 * - R009 保留本地目标值：创建新资料版本、新同步意图与新幂等键，重新进入待同步
 *   （不在本地事务伪造 Casdoor 已写入）；
 * - R010 接受 Casdoor 当前值：本地采用经本人确认的外部值并关闭冲突窗口，不新起同步；
 * - 只读权威字段（姓名/学号）不经本人选择（R008 守卫），字段不在白名单 → 422 IFC-ERR-006。
 */

import { randomUUID } from 'node:crypto';
import {
  isEditableProfileField,
  type EditableProfileField as EditableFieldName,
} from '../../domain/models/profile-field';
import { Profile } from '../../domain/models/profile';
import type { ProfileSnapshot } from '../../domain/models/profile';
import { ProfileSyncIntent } from '../../domain/models/profile-sync-intent';
import { ProfileSyncState } from '../../domain/state-machines/profile-sync.state-machine';
import type { ProfileSyncStateMachine } from '../../domain/state-machines/profile-sync.state-machine';
import type { ProfileWriteGateStateMachine } from '../../domain/state-machines/profile-write-gate.state-machine';
import type { ProfileGatePolicy } from '../../domain/services/profile-gate.policy';
import type { ProfileRepository } from '../ports/profile-repository.port';
import type { ProfileSyncIntentRepository } from '../ports/profile-sync-intent-repository.port';
import type { CasdoorUserPort } from '../ports/casdoor-user.port';
import type { ProfileSyncTaskPort } from '../ports/profile-sync-task.port';
import type { IdentityAuditPort } from '../ports/identity-audit.port';
import { identityErrors } from '../errors';

export interface ResolveSyncConflictInput {
  readonly subjectId: string;
  readonly field: EditableFieldName;
  readonly chosenValue: string;
  readonly now: Date;
  readonly actor: string;
  readonly traceId: string | null;
}

export type ConflictResolution =
  | { readonly kind: 'KEPT_LOCAL'; readonly nextIntentId: string }
  | { readonly kind: 'ACCEPTED_CASDOOR' };

export interface ResolveSyncConflictUseCase {
  execute(input: ResolveSyncConflictInput): Promise<ConflictResolution>;
}

export class DefaultResolveSyncConflictUseCase implements ResolveSyncConflictUseCase {
  constructor(
    private readonly syncIntentRepository: ProfileSyncIntentRepository,
    private readonly profileRepository: ProfileRepository,
    private readonly casdoor: CasdoorUserPort,
    private readonly taskPort: ProfileSyncTaskPort,
    private readonly audit: IdentityAuditPort,
    private readonly machine: ProfileSyncStateMachine,
    private readonly gateMachine: ProfileWriteGateStateMachine,
    private readonly gatePolicy: ProfileGatePolicy,
  ) {}

  async execute(input: ResolveSyncConflictInput): Promise<ConflictResolution> {
    if (!isEditableProfileField(input.field)) {
      throw identityErrors.preconditionFailed('该字段不在同步冲突选择白名单');
    }
    const profileSnapshot = await this.profileRepository.load(input.subjectId);
    if (!profileSnapshot) {
      throw identityErrors.notFound('资料');
    }
    const intentSnapshot = await this.syncIntentRepository.load(input.subjectId, input.field);
    if (!intentSnapshot || intentSnapshot.state !== ProfileSyncState.CONFLICT_PENDING_USER_CHOICE) {
      throw identityErrors.preconditionFailed('该字段不存在待选择的同步冲突');
    }
    const intent = ProfileSyncIntent.fromSnapshot(intentSnapshot);

    if (profileSnapshot.version !== intentSnapshot.conflictVersion) {
      throw identityErrors.preconditionFailed('冲突版本已变化，请刷新后重新选择');
    }

    const readback = await this.casdoor.readProfileField(input.subjectId, input.field);
    if (readback.status !== 'SUCCESS' || readback.data === null) {
      throw identityErrors.preconditionFailed('Casdoor 当前值无法确认，请稍后重试');
    }
    if (readback.data.value !== intentSnapshot.readbackValue) {
      throw identityErrors.preconditionFailed('冲突当前值已变化，请刷新后重新选择');
    }

    if (input.chosenValue === intentSnapshot.targetValue) {
      return this.keepLocal(intent, profileSnapshot, input);
    }
    if (input.chosenValue === readback.data.value) {
      return this.acceptCasdoor(intent, input);
    }
    throw identityErrors.preconditionFailed('选择值必须是本地目标值或 Casdoor 当前值之一');
  }

  /** R009 本人保留本地目标值：关闭旧冲突窗口，创建新版本与新同步意图重新进入待同步 */
  private async keepLocal(
    intent: ProfileSyncIntent,
    profileSnapshot: ProfileSnapshot,
    input: ResolveSyncConflictInput,
  ): Promise<ConflictResolution> {
    if (!intent.keepLocal(this.machine, true, input.now)) {
      throw identityErrors.preconditionFailed('冲突选择无法落位，请刷新后重试');
    }
    await this.syncIntentRepository.save(intent.toSnapshot(), intent.events);

    const profile = Profile.fromSnapshot(profileSnapshot);
    profile.bumpVersionForConflictRetry(input.now);
    const newVersion = profile.version;
    const nextIntent = ProfileSyncIntent.create({
      id: randomUUID(),
      subjectId: input.subjectId,
      field: input.field,
      targetVersion: newVersion,
      priorValue: intent.toSnapshot().readbackValue,
      targetValue: intent.toSnapshot().targetValue,
      now: input.now,
    });
    const nextSnapshot = nextIntent.toSnapshot();

    await this.profileRepository.save(profile.toSnapshot(), profile.events);
    await this.syncIntentRepository.save(nextSnapshot, nextIntent.events);
    await this.taskPort.scheduleProfileSync(
      input.subjectId,
      input.field,
      newVersion,
      nextSnapshot.id,
    );
    await this.audit.record({
      type: 'PROFILE_SYNC_CONFLICT',
      subjectId: input.subjectId,
      occurredAt: input.now,
      actor: input.actor,
      traceId: input.traceId,
      summary: {
        field: input.field,
        targetVersion: newVersion,
        outcome: 'USER_KEPT_LOCAL',
      },
    });

    return { kind: 'KEPT_LOCAL', nextIntentId: nextSnapshot.id };
  }

  /** R010 本人接受 Casdoor 当前值：本地采用外部值并关闭冲突窗口，不新起同步 */
  private async acceptCasdoor(
    intent: ProfileSyncIntent,
    input: ResolveSyncConflictInput,
  ): Promise<ConflictResolution> {
    const intentSnapshot = intent.toSnapshot();
    if (!intent.acceptCasdoor(this.machine, true, input.now)) {
      throw identityErrors.preconditionFailed('冲突选择无法落位，请刷新后重试');
    }
    const profileSnapshot = await this.profileRepository.load(input.subjectId);
    if (!profileSnapshot) {
      throw identityErrors.notFound('资料');
    }
    const profile = Profile.fromSnapshot(profileSnapshot);
    if (
      !profile.adoptExternalValue(this.gateMachine, this.gatePolicy, input.field, input.chosenValue, input.now)
    ) {
      throw identityErrors.preconditionFailed('本地无法采用 Casdoor 当前值');
    }

    await this.profileRepository.save(profile.toSnapshot(), profile.events);
    await this.syncIntentRepository.save(intent.toSnapshot(), intent.events);
    await this.audit.record({
      type: 'PROFILE_SYNC_CONFLICT',
      subjectId: input.subjectId,
      occurredAt: input.now,
      actor: input.actor,
      traceId: input.traceId,
      summary: {
        field: input.field,
        targetVersion: intentSnapshot.targetVersion,
        outcome: 'USER_ACCEPTED_CASDOOR',
        readbackValue: redactForAudit(intentSnapshot.readbackValue),
      },
    });

    return { kind: 'ACCEPTED_CASDOOR' };
  }
}

function redactForAudit(value: string | null): string {
  if (value === null || value.length === 0) {
    return value ?? '';
  }
  return `${value.slice(0, 2)}***`;
}