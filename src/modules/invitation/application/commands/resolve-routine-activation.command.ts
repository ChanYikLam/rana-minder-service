import { Inject, Injectable } from '@nestjs/common';
import { RoutineInvitationStateMachine } from '../../domain/state-machines/routine-invitation-state-machine';
import type { RelationSyncStatus, RoutineInvitation } from '../../domain/models/routine-invitation';
import { RelationSyncStatus as Sync } from '../../domain/models/routine-invitation';
import { CASDOOR_RELATION_PORT } from '../../infrastructure/casdoor-relation-port';
import type { CasdoorRelationPort } from '../../infrastructure/casdoor-relation-port';
import { ROUTINE_INVITATION_REPOSITORY } from '../../infrastructure/routine-invitation-repository';
import type { RoutineInvitationRepository } from '../../infrastructure/routine-invitation-repository';

/** 激活解析输入（系统关系任务；SRS-SM-MEM-004） */
export interface ResolveRoutineActivationInput {
  readonly routineInvitationId: string;
  /** 多次回读/补偿后仍无法确认且**无法补偿到非成员**（调用方判定；→高优先级同步异常） */
  readonly escalateToAnomaly: boolean;
}

/** 激活解析结果 */
export interface ResolveRoutineActivationResult {
  readonly invitation: RoutineInvitation;
  /** 已生效（社团及可选部门全部回读确认） */
  readonly activated: boolean;
  /** 高优先级同步异常（冻结普通重试；通知超管） */
  readonly anomaly: boolean;
}

/**
 * 常规入社激活解析（SRS-SM-MEM-004；MEM-018、ORG-027）。
 *
 * - Casdoor 社团及可选部门关系**全部回读确认** → 已生效并开放权限；
 * - **只确认部分关系时不得成功**：按组合关系补偿（先回读后重试，无需本人重接）；
 * - 外部失败可重试 → 同步失败待重试；
 * - 无法确认且无法补偿到非成员 → **高优先级同步异常**：冻结普通重试、
 *   维持最小权限并通知超管（通知由审计/通知模块占位承接）；
 * - 不得提前授予权限、静默降级初始部门或要求本人重接收。
 */
@Injectable()
export class ResolveRoutineActivationCommand {
  constructor(
    @Inject(ROUTINE_INVITATION_REPOSITORY) private readonly repo: RoutineInvitationRepository,
    @Inject(CASDOOR_RELATION_PORT) private readonly casdoor: CasdoorRelationPort,
    private readonly stateMachine: RoutineInvitationStateMachine = new RoutineInvitationStateMachine(),
  ) {}

  async execute(input: ResolveRoutineActivationInput): Promise<ResolveRoutineActivationResult> {
    const invitation = await this.repo.load(input.routineInvitationId);
    if (invitation === null) {
      throw new Error('IFC-ERR-006: 邀请不存在');
    }
    if (
      invitation.status !== 'ACCEPTED_PENDING_ACTIVATION' &&
      invitation.status !== 'SYNC_FAILED_PENDING_RETRY'
    ) {
      throw new Error('IFC-ERR-007: 邀请不在待生效/重试状态');
    }
    if (invitation.status === 'SYNC_FAILED_PENDING_RETRY' && input.escalateToAnomaly) {
      // 重试中升级 → 高优先级同步异常（冻结普通重试）
      return this.toAnomaly(invitation);
    }

    // 组合写入并分别回读（社团 Group + 可选初始部门）
    const result = await this.casdoor.writeAndReadBackRelations(
      invitation.clubId,
      invitation.inviteeId,
      invitation.initialDepartmentId,
    );
    const now = new Date().toISOString();
    const attempt = invitation.attemptCount + 1;

    // 全部确认 → 已生效（开放权限）
    if (result.groupConfirmed && result.departmentConfirmed) {
      const activated: RoutineInvitation = {
        ...invitation,
        status: this.stateMachine.transition(invitation.status, 'ACTIVATED'),
        version: invitation.version + 1,
        activatedAt: now,
        syncStatus: Sync.ALL_CONFIRMED,
        attemptCount: attempt,
        relationTargets: invitation.relationTargets.map((t) => ({ ...t, confirmed: true })),
        lastError: undefined,
        history: [...invitation.history, { at: now, type: 'ACTIVATED', by: 'system' }],
      };
      if (!(await this.repo.compareAndSwap(invitation, activated))) {
        throw new Error('IFC-ERR-007: 邀请状态已被并发变更，激活失败');
      }
      return { invitation: activated, activated: true, anomaly: false };
    }

    // 部分确认或全未确认：不得成功（不得开放权限）
    // 按实际组合目标数判定：仅 GROUP（未指定初始部门）时，group 未确认属唯一目标未确认（UNCONFIRMED）
    const confirmedCount = invitation.relationTargets.filter((t) =>
      t.kind === 'GROUP' ? result.groupConfirmed : result.departmentConfirmed,
    ).length;
    const partial = confirmedCount > 0 && confirmedCount < invitation.relationTargets.length;
    const syncStatus: RelationSyncStatus = partial ? Sync.PARTIAL : Sync.UNCONFIRMED;

    // 无法确认且无法补偿到非成员 → 高优先级同步异常
    if (input.escalateToAnomaly) {
      return this.toAnomaly(invitation);
    }

    // 可重试：同步失败待重试（先回读后重试；无需本人重接；部分确认按组合补偿）
    const retry: RoutineInvitation = {
      ...invitation,
      status: this.stateMachine.transition(invitation.status, 'SYNC_FAILED_PENDING_RETRY'),
      version: invitation.version + 1,
      syncStatus,
      attemptCount: attempt,
      lastError: result.reason ?? 'casdoor-composite-not-confirmed',
      relationTargets: invitation.relationTargets.map((t) => ({
        ...t,
        confirmed: t.kind === 'GROUP' ? result.groupConfirmed : result.departmentConfirmed,
      })),
      history: [...invitation.history, { at: now, type: 'SYNC_FAILED', by: 'system' }],
    };
    if (!(await this.repo.compareAndSwap(invitation, retry))) {
      throw new Error('IFC-ERR-007: 邀请状态已被并发变更，重试失败');
    }
    return { invitation: retry, activated: false, anomaly: false };
  }

  private async toAnomaly(invitation: RoutineInvitation): Promise<ResolveRoutineActivationResult> {
    const now = new Date().toISOString();
    const anomaly: RoutineInvitation = {
      ...invitation,
      status: this.stateMachine.transition(invitation.status, 'HIGH_PRIORITY_SYNC_ANOMALY'),
      version: invitation.version + 1,
      syncStatus: Sync.ANOMALY,
      attemptCount: invitation.attemptCount + 1,
      lastError: 'unrecoverable-composite-sync',
      history: [...invitation.history, { at: now, type: 'HIGH_PRIORITY_ANOMALY', by: 'system' }],
    };
    if (!(await this.repo.compareAndSwap(invitation, anomaly))) {
      throw new Error('IFC-ERR-007: 邀请状态已被并发变更，异常收口失败');
    }
    // 通知本人、发送方和超级管理员由通知/审计模块承接（本命令只收口状态；维持最小权限）
    return { invitation: anomaly, activated: false, anomaly: true };
  }
}
