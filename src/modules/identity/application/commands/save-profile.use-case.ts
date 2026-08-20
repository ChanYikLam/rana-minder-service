/**
 * 保存平台公共资料用例（IFC-SM-002 R001/R002；IDN-002/006/010/019）。
 *
 * 流程：乐观锁校验 → 只写白名单字段（邮箱进入待验证）→ 重算全部资料门 →
 * 为非邮箱白名单字段创建同步意图并登记任务 → 同一事务提交资料/意图/审计。
 *
 * 边界（IFC-TX-001）：
 * - 版本不匹配 → 409 IFC-ERR-008（不自动重放）；
 * - 任一必需事实保存失败整体拒绝；
 * - 邮箱修改不直接替换当前有效邮箱，进入待验证（IDN-011），同步在验证成功后发起。
 */

import { randomUUID } from 'node:crypto';
import { EditableProfileField } from '../../domain/models/profile-field';
import { Profile } from '../../domain/models/profile';
import { ProfileSyncIntent } from '../../domain/models/profile-sync-intent';
import type { ProfileWriteGateStateMachine } from '../../domain/state-machines/profile-write-gate.state-machine';
import type { ProfileGatePolicy } from '../../domain/services/profile-gate.policy';
import type { ProfileRepository } from '../ports/profile-repository.port';
import type { ProfileSyncIntentRepository } from '../ports/profile-sync-intent-repository.port';
import type { RequiredFieldRulesPort } from '../ports/required-field-rules.port';
import type { ProfileSyncTaskPort } from '../ports/profile-sync-task.port';
import type { IdentityAuditPort } from '../ports/identity-audit.port';
import { identityErrors } from '../errors';

export interface SaveProfileInput {
  readonly subjectId: string;
  readonly expectedVersion: number;
  readonly fields: Partial<Record<EditableProfileField, string>>;
  readonly now: Date;
  readonly actor: string;
  readonly traceId: string | null;
}

export interface SaveProfileResult {
  readonly profile: Profile;
  readonly changedFields: readonly EditableProfileField[];
  readonly pendingSyncFields: readonly EditableProfileField[];
  readonly syncIntentIds: readonly string[];
}

export interface SaveProfileUseCase {
  execute(input: SaveProfileInput): Promise<SaveProfileResult>;
}

export class DefaultSaveProfileUseCase implements SaveProfileUseCase {
  constructor(
    private readonly profileRepository: ProfileRepository,
    private readonly syncIntentRepository: ProfileSyncIntentRepository,
    private readonly requiredFields: RequiredFieldRulesPort,
    private readonly taskPort: ProfileSyncTaskPort,
    private readonly audit: IdentityAuditPort,
    private readonly gateMachine: ProfileWriteGateStateMachine,
    private readonly gatePolicy: ProfileGatePolicy,
  ) {}

  async execute(input: SaveProfileInput): Promise<SaveProfileResult> {
    const snapshot = await this.profileRepository.load(input.subjectId);
    if (!snapshot) {
      throw identityErrors.notFound('资料');
    }
    const profile = Profile.fromSnapshot(snapshot);

    const saved = profile.saveEditableFields({
      fields: input.fields,
      expectedVersion: input.expectedVersion,
      now: input.now,
    });
    if (!saved) {
      if (input.expectedVersion !== snapshot.version) {
        throw identityErrors.versionConflict();
      }
      throw identityErrors.preconditionFailed('没有可保存的白名单字段，或包含只读权威字段/未知字段');
    }

    const required = await this.requiredFields.getPlatformRequiredFields(input.now);
    const missingFields = required
      .filter((r) => r.effectiveAt.getTime() <= input.now.getTime())
      .map((r) => r.field)
      .filter((field) => this.isMissing(profile, field));

    profile.recomputeGate(this.gateMachine, this.gatePolicy, missingFields, input.now);

    const syncFields = profile.events
      .flatMap((e) => (e.type === 'PROFILE_SAVED' ? e.payload.pendingSyncFields ?? [] : []))
      .filter((f) => f !== EditableProfileField.EMAIL);

    const syncIntentIds: string[] = [];
    for (const field of syncFields) {
      const nextValue = profile.toSnapshot().fields[field];
      const priorValue = snapshot.fields[field] ?? null;
      if (nextValue === undefined) {
        continue;
      }
      const intent = ProfileSyncIntent.create({
        id: randomUUID(),
        subjectId: input.subjectId,
        field,
        targetVersion: profile.version,
        priorValue,
        targetValue: nextValue,
        now: input.now,
      });
      await this.syncIntentRepository.save(intent.toSnapshot(), intent.events);
      syncIntentIds.push(intent.toSnapshot().targetVersion + ':' + field);
      await this.taskPort.scheduleProfileSync(
        input.subjectId,
        field,
        intent.toSnapshot().targetVersion,
        intent.toSnapshot().id,
      );
    }

    await this.profileRepository.save(profile.toSnapshot(), profile.events, snapshot.version);

    await this.audit.record({
      type: 'PROFILE_SAVED',
      subjectId: input.subjectId,
      occurredAt: input.now,
      actor: input.actor,
      traceId: input.traceId,
      summary: {
        version: profile.version,
        changedFields: profile.events
          .flatMap((e) => (e.type === 'PROFILE_SAVED' ? e.payload.changedFields ?? [] : []))
          .filter((f) => f !== EditableProfileField.EMAIL),
        pendingEmail: profile.pendingEmail === null ? null : true,
      },
    });

    return {
      profile,
      changedFields: profile.events.flatMap((e) =>
        e.type === 'PROFILE_SAVED' ? e.payload.changedFields ?? [] : [],
      ),
      pendingSyncFields: syncFields,
      syncIntentIds,
    };
  }

  private isMissing(profile: Profile, field: string): boolean {
    const snapshot = profile.toSnapshot();
    const value = snapshot.fields[field as keyof typeof snapshot.fields];
    return value === undefined || value === null || value.trim() === '';
  }
}