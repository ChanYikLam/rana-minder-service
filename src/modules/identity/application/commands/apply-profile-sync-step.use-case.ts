/**
 * 资料同步单步执行用例（IFC-SM-003；IDN-003/006/007/020、CAS-WR-*、CAS-REC-001）。
 *
 * 由 job 同步任务逐次调用，一次执行一个字段版本的一步：
 * 启动写入 → Casdoor 写回 → 定向读回 → 按读回值收口为已同步/已回退/冲突/收敛。
 *
 * 关键约束（CAS-WR-006/007、IDN-007）：
 * - 写后定向读回是唯一成功收口；先可信读回才可回退，防止把已成功写入制造成不一致；
 * - 存在更晚本地版本时旧意图不得推进（旧回调/旧任务按版本拒绝）；
 * - 连续失败 24 小时停止盲目写重试，转强制读回（R005）；
 * - 结果不确定（UNCERTAIN）先读回再重试，不得伪成功。
 */

import { ProfileSyncIntent } from '../../domain/models/profile-sync-intent';
import type { EditableProfileField } from '../../domain/models/profile-field';
import type { ProfileSyncStateMachine } from '../../domain/state-machines/profile-sync.state-machine';
import type { ProfileSyncPolicy, ReadbackFacts } from '../../domain/services/profile-sync.policy';
import type { ProfileSyncIntentRepository } from '../ports/profile-sync-intent-repository.port';
import type { CasdoorUserPort } from '../ports/casdoor-user.port';
import type { ProfileSyncTaskPort } from '../ports/profile-sync-task.port';
import type { IdentityAuditPort } from '../ports/identity-audit.port';
import type { ProfileRepository } from '../ports/profile-repository.port';
import { identityErrors } from '../errors';

export type SyncStepOutcome =
  | { readonly kind: 'SYNCED' }
  | { readonly kind: 'ROLLED_BACK' }
  | { readonly kind: 'CONFLICT' }
  | { readonly kind: 'CONVERGED' }
  | { readonly kind: 'RETRY_SCHEDULED'; readonly retryAt: Date }
  | { readonly kind: 'READBACK_SCHEDULED' }
  | { readonly kind: 'WAITING_USER' }
  | { readonly kind: 'IDLE' };

export interface ApplyProfileSyncStepInput {
  readonly subjectId: string;
  readonly field: EditableProfileField;
  readonly targetVersion: number;
  readonly intentId: string;
  readonly now: Date;
  readonly actor: string;
  readonly traceId: string | null;
}

export interface ApplyProfileSyncStepUseCase {
  execute(input: ApplyProfileSyncStepInput): Promise<SyncStepOutcome>;
}

export class DefaultApplyProfileSyncStepUseCase implements ApplyProfileSyncStepUseCase {
  constructor(
    private readonly syncIntentRepository: ProfileSyncIntentRepository,
    private readonly profileRepository: ProfileRepository,
    private readonly casdoor: CasdoorUserPort,
    private readonly taskPort: ProfileSyncTaskPort,
    private readonly audit: IdentityAuditPort,
    private readonly machine: ProfileSyncStateMachine,
    private readonly policy: ProfileSyncPolicy,
  ) {}

  async execute(input: ApplyProfileSyncStepInput): Promise<SyncStepOutcome> {
    const snapshot = await this.syncIntentRepository.load(input.subjectId, input.field);
    if (!snapshot) {
      throw identityErrors.notFound('同步意图');
    }
    if (snapshot.targetVersion !== input.targetVersion) {
      throw identityErrors.versionConflict();
    }
    const intent = ProfileSyncIntent.fromSnapshot(snapshot);
    const profile = await this.profileRepository.load(input.subjectId);
    const isCurrentVersion = profile !== null && profile.version === snapshot.targetVersion;

    if (!isCurrentVersion) {
      // 存在更晚本地版本：旧同步意图不得推进（IDN-007）
      await this.audit.record({
        type: 'PROFILE_SYNC_OUTCOME',
        subjectId: input.subjectId,
        occurredAt: input.now,
        actor: input.actor,
        traceId: input.traceId,
        summary: { field: input.field, targetVersion: input.targetVersion, outcome: 'STALE_SKIPPED' },
      });
      return { kind: 'IDLE' };
    }

    switch (snapshot.state) {
      case 'PENDING_SYNC':
        return this.runWriteStep(intent, input);
      case 'RETRYING':
        return this.runWriteStep(intent, input);
      case 'PENDING_READBACK_VERIFICATION':
        return this.runReadbackStep(intent, input, isCurrentVersion);
      case 'CONFLICT_PENDING_USER_CHOICE':
      case 'ROLLED_BACK':
      case 'SYNCED':
      case 'MANUAL_INTERVENTION':
        return { kind: 'IDLE' };
    }
  }

  private async runWriteStep(
    intent: ProfileSyncIntent,
    input: ApplyProfileSyncStepInput,
  ): Promise<SyncStepOutcome> {
    if (intent.state === 'PENDING_SYNC') {
      if (!intent.startWrite(this.machine, true)) {
        throw identityErrors.preconditionFailed('同步意图状态不允许启动写入');
      }
      await this.syncIntentRepository.save(intent.toSnapshot(), intent.events);
    }

    const snapshot = intent.toSnapshot();
    const write = await this.casdoor.writeProfileField(input.subjectId, input.field, snapshot.targetValue);
    if (write.status !== 'SUCCESS' || write.data === null) {
      return this.handleFailure(intent, input, write.status, write.attemptId);
    }

    const readback = await this.casdoor.readProfileField(input.subjectId, input.field);
    if (readback.status !== 'SUCCESS' || readback.data === null) {
      return this.handleFailure(intent, input, readback.status, readback.attemptId);
    }

    if (readback.data.value === snapshot.targetValue) {
      // R003 写入并回读确认目标值：重试中 → 已同步
      if (!intent.confirmTarget(this.machine, true, input.now)) {
        throw identityErrors.preconditionFailed('写入确认无法落位（保持重试中）');
      }
      const next = intent.toSnapshot();
      await this.syncIntentRepository.save(next, intent.events);
      await this.audit.record({
        type: 'PROFILE_SYNC_OUTCOME',
        subjectId: input.subjectId,
        occurredAt: input.now,
        actor: input.actor,
        traceId: input.traceId,
        summary: {
          field: input.field,
          targetVersion: next.targetVersion,
          outcome: 'SYNCED',
          readbackValue: redactForAudit(readback.data.value),
        },
      });
      return { kind: 'SYNCED' };
    }

    // 写入未在 Casdoor 落位（回读非目标值）：视为本次写入未确认，按 R004 退避重试；
    // 连续失败满 24 小时才进入强制读回（R005），届时再按 R006/R007/R008 收口。
    return this.handleFailure(intent, input, 'READBACK_MISMATCH', readback.attemptId);
  }

  private async runReadbackStep(
    intent: ProfileSyncIntent,
    input: ApplyProfileSyncStepInput,
    isCurrentVersion: boolean,
  ): Promise<SyncStepOutcome> {
    const readback = await this.casdoor.readProfileField(input.subjectId, input.field);
    if (readback.status !== 'SUCCESS' || readback.data === null) {
      return this.handleFailure(intent, input, readback.status, readback.attemptId);
    }
    return this.routeReadback(intent, input, readback.data.value, isCurrentVersion);
  }

  private async routeReadback(
    intent: ProfileSyncIntent,
    input: ApplyProfileSyncStepInput,
    readbackValue: string | null,
    isCurrentVersion: boolean,
  ): Promise<SyncStepOutcome> {
    const snapshot = intent.toSnapshot();
    const facts: ReadbackFacts = {
      field: input.field,
      targetValue: snapshot.targetValue,
      priorValue: snapshot.priorValue,
      readbackValue,
      hasNewerConfirmedChange: !isCurrentVersion,
    };
    const decision = this.policy.decideReadback(facts);

    if (!intent.applyReadback(this.machine, decision, readbackValue, isCurrentVersion, input.now)) {
      throw identityErrors.preconditionFailed('读回收口决策无法落位（保持待读回核验）');
    }
    const next = intent.toSnapshot();
    await this.syncIntentRepository.save(next, intent.events);

    await this.audit.record({
      type: decision === 'CONFLICT' ? 'PROFILE_SYNC_CONFLICT' : 'PROFILE_SYNC_OUTCOME',
      subjectId: input.subjectId,
      occurredAt: input.now,
      actor: input.actor,
      traceId: input.traceId,
      summary: {
        field: input.field,
        targetVersion: next.targetVersion,
        outcome: decision,
        readbackValue: redactForAudit(readbackValue),
      },
    });

    switch (decision) {
      case 'SYNCED':
        return { kind: 'SYNCED' };
      case 'ROLLED_BACK':
        return { kind: 'ROLLED_BACK' };
      case 'CONFLICT':
        return { kind: 'CONFLICT' };
      case 'CONVERGE_AUTHORITATIVE':
        return { kind: 'CONVERGED' };
      case 'READBACK_UNTRUSTWORTHY':
        return { kind: 'IDLE' };
    }
  }

  private async handleFailure(
    intent: ProfileSyncIntent,
    input: ApplyProfileSyncStepInput,
    status: string,
    attemptId: string,
  ): Promise<SyncStepOutcome> {
    const snapshot = intent.toSnapshot();
    const failedSince = snapshot.failedSince ?? input.now;

    if (this.policy.isBeyond24Hours(failedSince, input.now)) {
      if (!intent.freezeAfter24Hours(this.machine, true)) {
        throw identityErrors.preconditionFailed('同步意图状态不允许冻结盲写重试');
      }
      await this.syncIntentRepository.save(intent.toSnapshot(), intent.events);
      await this.taskPort.scheduleProfileReadback(
        input.subjectId,
        input.field,
        snapshot.targetVersion,
        snapshot.id,
      );
      await this.audit.record({
        type: 'PROFILE_SYNC_OUTCOME',
        subjectId: input.subjectId,
        occurredAt: input.now,
        actor: input.actor,
        traceId: input.traceId,
        summary: {
          field: input.field,
          targetVersion: snapshot.targetVersion,
          outcome: 'FROZEN_24H',
          externalStatus: status,
          attemptId,
        },
      });
      return { kind: 'READBACK_SCHEDULED' };
    }

    if (!intent.recordTransientFailure(this.machine, this.policy, true, input.now)) {
      throw identityErrors.preconditionFailed('同步意图状态不允许登记临时失败');
    }
    const next = intent.toSnapshot();
    await this.syncIntentRepository.save(next, intent.events);
    await this.taskPort.scheduleProfileSync(
      input.subjectId,
      input.field,
      next.targetVersion,
      next.id,
    );
    await this.audit.record({
      type: 'PROFILE_SYNC_OUTCOME',
      subjectId: input.subjectId,
      occurredAt: input.now,
      actor: input.actor,
      traceId: input.traceId,
      summary: {
        field: input.field,
        targetVersion: next.targetVersion,
        outcome: 'TRANSIENT_FAILURE',
        externalStatus: status,
        attemptId,
        attempts: next.attempts,
      },
    });
    return { kind: 'RETRY_SCHEDULED', retryAt: next.retryAt ?? input.now };
  }
}

function redactForAudit(value: string | null): string {
  if (value === null || value.length === 0) {
    return value ?? '';
  }
  return `${value.slice(0, 2)}***`;
}