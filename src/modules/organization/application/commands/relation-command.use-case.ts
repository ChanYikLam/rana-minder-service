/**
 * ORG-002 Group 关系命令命令用例（SRS-SM-ORG-002 §4.2）。
 *
 * HTTP 端点：§15.1 org 域关系命令（POST /api/org/:clubId/members/appointments 等
 * 提交关系变更、transition 提交/重试）。
 *
 * 关键语义：
 * - 提交：校验前置条件（权限/社团状态/成员前提/对象版本/处理中冲突/负责人连续
 *   性），原子保存命令＋原关系快照＋目标关系＋执行任务；原关系/权限继续有效
 *   （ORG-027、SRS-SM-ORG-002 提交行）。
 * - 处理：写后回读确认才正式生效；15 分钟有界重试先回读；复合部分成功逆序补偿。
 * - 人工重试：重新鉴权 + 重读实际关系（ORG-027 人工重试行）。
 */

import { randomUUID } from 'node:crypto';

import type { RelationCommand } from '../../domain/models/relation-command';
import { createRelationCommand } from '../../domain/models/relation-command';
import { PermissionCatalog } from '../../domain/models/permission-template';
import { LastOwnerContinuityPolicy } from '../../domain/services/last-owner-continuity.policy';
import { RelationCommandStateMachine } from '../../domain/state-machines/relation-command.state-machine';
import type { RelationCommandType, RelationWriteStep } from '../../domain/types';
import { IdPrefix, orgError } from '../../domain/types';
import {
  CASDOOR_GROUP_PORT,
  CLUB_STORE,
  CURRENT_PERMISSIONS_PORT,
  JOB_SCHEDULER,
  NOTIFICATION_PORT,
  RELATION_COMMAND_STORE,
  RELATION_COMMAND_USE_CASE,
  type CasdoorGroupPort,
  type ClubStore,
  type CurrentPermissionsPort,
  type JobSchedulerPort,
  type NotificationPort,
  type RelationCommandStore,
} from '../ports';

export interface SubmitRelationCommandInput {
  clubId: string;
  type: RelationCommandType;
  subjectId: string;
  targetGroups: Array<{ ref: { owner: string; name: string }; kind: 'add' | 'remove' }>;
  objectVersion: number;
  idempotencyKey: string;
  submittedBy: string;
}

export class RelationCommandUseCase {
  private readonly stateMachine = new RelationCommandStateMachine();
  /** 回读收口回调（预约命令侧订阅：关系命令确认/失败后推进预约状态机） */
  private readbackSink: ((command: RelationCommand) => Promise<void>) | null = null;

  constructor(
    private readonly store: RelationCommandStore,
    private readonly clubs: ClubStore,
    private readonly casdoor: CasdoorGroupPort,
    private readonly scheduler: JobSchedulerPort,
    private readonly notifications: NotificationPort,
    private readonly permissions: CurrentPermissionsPort,
  ) {}

  /** 订阅回读收口回调（ORG-027 写后回读确认 → 上游命令收口） */
  setReadbackSink(sink: (command: RelationCommand) => Promise<void>): void {
    this.readbackSink = sink;
  }

  async submit(input: SubmitRelationCommandInput, now: Date): Promise<RelationCommand> {
    const club = await this.clubs.findById(input.clubId);
    if (club === null) throw orgError.notVisible(`社团空间不存在（${input.clubId}）`);
    if (club.status !== 'enabled') {
      throw orgError.precondition(`社团当前 ${club.status}，禁止关系变更（ORG-001）`);
    }

    // 权限校验：提交者须有成员/关系管理权限（ORG-027 提交行）
    const perms = await this.permissions.effectiveForClub(input.submittedBy, input.clubId);
    if (!perms.includes(PermissionCatalog.CLUB_MEMBER_MANAGE)) {
      throw orgError.forbidden('提交者无成员关系管理权限（ORG-027）');
    }

    // 同一目标处理中禁止重复/冲突操作（SRS-SM-ORG-002）
    const inFlight = await this.store.findByProcessingForSubject(input.clubId, input.subjectId);
    if (inFlight !== null) {
      if (inFlight.idempotencyKey === input.idempotencyKey) {
        return inFlight; // 客户端重试幂等
      }
      throw orgError.stateConflict(
        `同一目标存在处理中关系命令 ${inFlight.id}，禁止并发冲突操作（IFC-ERR-007）`,
      );
    }

    // 幂等键命中已有终结结果
    const existing = await this.store.findByExactIdempotencyKey(
      input.idempotencyKey,
      input.subjectId,
      input.type,
    );
    if (existing !== null) return existing;

    const steps = this.buildSteps(input, now);
    await this.assertMemberPrerequisite(club.clubGroup, input.subjectId);
    // 最后负责人连续性（ORG-024）：撤销最后一名负责人须有继任者，严禁零负责人窗口
    await this.assertOwnerContinuity(input, club);

    const command = createRelationCommand({
      id: newId(IdPrefix.RELATION_COMMAND),
      clubId: input.clubId,
      type: input.type,
      subjectId: input.subjectId,
      originalRelation: steps.original,
      targetRelation: steps.target,
      objectVersion: input.objectVersion,
      idempotencyKey: input.idempotencyKey,
      submittedBy: input.submittedBy,
      now,
    });

    const result = this.stateMachine.transition({
      command,
      event: 'submit',
      now,
      facts: {},
    });
    await this.store.save(result.command);
    await this.scheduler.enqueue({
      taskId: `tsk-rel-${command.id}`,
      kind: 'relation_execute',
      refId: command.id,
      scheduleType: 'immediate',
      at: null,
      idempotencyKey: `relation-exec:${command.id}`,
      leaseHolder: null,
    });
    return result.command;
  }

  /**
   * 登记目标关系图（CAS-Q-001 方案 A）。
   *
   * 骨架阶段排序现状：orderFor 只按 add=1 / remove=0 排序，即"先撤销后新增"，
   * 尚未实现文档所述"基础/低权限 → 具体/高权限"的按 Group 用途排序——因为
   * SubmitRelationCommandInput.targetGroups 不携带 purpose 信息，无法区分
   * 社团/部门/职位层级。真实适配器须在提供 Group purpose 后落地该排序。
   */
  private buildSteps(
    input: SubmitRelationCommandInput,
    _now: Date,
  ): {
    original: RelationWriteStep[];
    target: RelationWriteStep[];
  } {
    const orderFor = (kind: 'add' | 'remove'): number => (kind === 'add' ? 1 : 0);
    const targets = input.targetGroups.map((tg) => ({
      ...tg,
      ref: { owner: tg.ref.owner, name: tg.ref.name },
    }));
    const ordered = targets
      .map((tg, index) => ({
        stepId: `step-${index}`,
        kind: tg.kind === 'add' ? ('add_member' as const) : ('remove_member' as const),
        targetGroup: tg.ref,
        subjectId: input.subjectId,
        idempotencyKey: `${input.idempotencyKey}:${index}`,
        order: orderFor(tg.kind),
        attemptCount: 0,
      }))
      .sort((a, b) => a.order - b.order);

    // 骨架限制：originalRelation 目前只是目标图的占位副本（标记 confirmed），
    // 并未反映 Casdoor 实际既有关系。ORG-027「原关系/原权限继续有效」依赖真实原
    // 关系快照，须由真实适配器在提交前回读 Casdoor 实况回填，否则补偿/回退语义不完整。
    const original = ordered.map((s) => ({ ...s, result: 'confirmed' as const }));
    return { original, target: ordered };
  }

  /** 成员前提：须先属于社团 Group 才能被任命到部门/职位（ORG-021） */
  private async assertMemberPrerequisite(
    clubGroup: { owner: string; name: string } | null,
    subjectId: string,
  ): Promise<void> {
    if (clubGroup === null) throw orgError.precondition('社团尚未绑定 Group');
    const members = await this.casdoor.getGroupMembers(clubGroup);
    if (!members.includes(subjectId)) {
      throw orgError.precondition(
        `用户 ${subjectId} 尚不属于社团 Group，不能任命到部门/职位（ORG-021）`,
      );
    }
  }

  /**
   * 最后负责人连续性（ORG-024）：命令若撤销/退出会移除 subject 的负责人职位，
   * 且 subject 是社团当前唯一负责人时拒绝，严禁零负责人窗口。
   *
   * 骨架限制：本模块关系命令为"单主体"命令，无法在同一命令内原子"撤销 A + 任命 B"；
   * 因此继任者须先经独立命令任命到位，本策略只保证不会出现零负责人窗口。
   */
  private async assertOwnerContinuity(
    input: SubmitRelationCommandInput,
    club: { leaderGroup: { owner: string; name: string } | null },
  ): Promise<void> {
    const leaderGroup = club.leaderGroup;
    if (leaderGroup === null) return; // 未配置负责人 Group（向导未完成/重绑后清空），无法判定
    const touchesLeader =
      input.type === 'leave_club' ||
      input.targetGroups.some(
        (tg) =>
          tg.kind === 'remove' &&
          tg.ref.owner === leaderGroup.owner &&
          tg.ref.name === leaderGroup.name,
      );
    if (!touchesLeader) return;
    const currentOwners = await this.casdoor.getGroupMembers(leaderGroup);
    LastOwnerContinuityPolicy.assertNoZeroOwnerWindow({
      currentOwners,
      subjectId: input.subjectId,
      // 单主体命令无法同命令指定继任者：继任者须先经独立任命命令落地
      successors: [],
    });
  }

  async handleReadback(
    input: { commandId: string; now: Date },
    readback: Awaited<ReturnType<CasdoorGroupPort['readback']>>,
  ): Promise<RelationCommand> {
    const command = await this.requireCommand(input.commandId);
    const stepResults = command.targetRelation.map((step) => {
      const members =
        readback.membersByGroup[`${step.targetGroup.owner}/${step.targetGroup.name}`] ?? [];
      const confirmed =
        step.kind === 'add_member'
          ? members.includes(step.subjectId)
          : !members.includes(step.subjectId);
      return { ...step, result: (confirmed ? 'confirmed' : 'failed') as 'confirmed' | 'failed' };
    });
    const allConfirmed = stepResults.every((s) => s.result === 'confirmed');
    const partiallyApplied =
      stepResults.some((s) => s.result === 'confirmed') &&
      stepResults.some((s) => s.result === 'failed');

    let event: 'readback_confirmed' | 'retry_attempt' | 'partial_write' | 'final_failure';
    const withinWindow = this.withinRetryWindow(command, input.now);
    if (allConfirmed) {
      event = 'readback_confirmed';
    } else if (partiallyApplied) {
      event = 'partial_write';
    } else {
      event = withinWindow ? 'retry_attempt' : 'final_failure';
    }

    const result = this.stateMachine.transition({
      command,
      event,
      now: input.now,
      facts: {
        readback: { confirmedSteps: stepResults },
        retryable: !partiallyApplied && !allConfirmed && withinWindow,
        withinRetryWindow: withinWindow,
      },
    });
    await this.store.save(result.command);
    if (event === 'readback_confirmed') {
      await this.notifications.save({
        kind: 'member',
        toUserIds: [command.subjectId],
        clubId: command.clubId,
        title: '关系变更已生效',
        body: `关系命令 ${command.id} 已回读确认生效`,
        dedupKey: `relation-confirmed:${command.id}`,
      });
    }
    // 收口通知：确认生效 / 失败保持原关系均推进上游（预约命令 settleExecution 收口）
    if (
      result.command.status === 'readback_confirmed' ||
      result.command.status === 'failed_original_preserved'
    ) {
      await this.readbackSink?.(result.command);
    }
    return result.command;
  }

  /**
   * 系统入口：调度/对账任务驱动回读收口（ORG-027 写后回读确认）。
   * 由调度器或对账任务以系统身份调用，读取目标 Group 实况并交由 handleReadback
   * 推进状态机；不允许普通用户经 HTTP 触发。
   */
  async systemConfirmReadback(input: { commandId: string; now: Date }): Promise<RelationCommand> {
    const command = await this.requireCommand(input.commandId);
    const refs = command.targetRelation.map((s) => s.targetGroup);
    const readback = await this.casdoor.readback(refs);
    return this.handleReadback({ commandId: command.id, now: input.now }, readback);
  }

  async manualRetry(input: {
    commandId: string;
    clubId: string;
    actor: string;
    now: Date;
  }): Promise<RelationCommand> {
    const command = await this.requireCommand(input.commandId);
    if (input.clubId !== command.clubId) {
      throw orgError.scopeMismatch(
        `URL 社团作用域 ${input.clubId} 与关系命令实际社团 ${command.clubId} 不一致（IFC-ERR-004）`,
      );
    }
    const actorAuthorized = await this.isVisibleAndAuthorized(input.actor, command);
    const result = this.stateMachine.transition({
      command,
      event: 'create_manual_retry',
      now: input.now,
      facts: { manualRetryAuthorized: actorAuthorized },
    });
    const reexecute = this.stateMachine.transition({
      command: result.command,
      event: 'manual_retry_executed',
      now: input.now,
      facts: {},
    });
    await this.store.save(reexecute.command);
    await this.scheduler.enqueue({
      taskId: `tsk-rel-retry-${command.id}`,
      kind: 'relation_execute',
      refId: command.id,
      scheduleType: 'immediate',
      at: null,
      idempotencyKey: `relation-retry:${command.id}:${command.commandVersion}`,
      leaseHolder: null,
    });
    return reexecute.command;
  }

  private withinRetryWindow(command: RelationCommand, now: Date): boolean {
    // 15 分钟有界自动重试窗口：deadline 起算，仅在 [deadline, deadline+15min] 内可重试（ORG-027）
    if (command.retryDeadline === null) return false;
    const deadline = Date.parse(command.retryDeadline);
    if (Number.isNaN(deadline)) return false;
    const windowMs = 15 * 60 * 1000;
    const current = now.getTime();
    return current >= deadline && current < deadline + windowMs;
  }

  private async requireCommand(commandId: string): Promise<RelationCommand> {
    const command = await this.store.findById(commandId);
    if (command === null) throw orgError.notVisible(`关系命令不存在（${commandId}）`);
    return command;
  }

  private async isVisibleAndAuthorized(actor: string, command: RelationCommand): Promise<boolean> {
    // 关系变更属成员管理：重试者须在当前社团拥有成员管理权限（ORG-027 人工重试行）
    const perms = await this.permissions.effectiveForClub(actor, command.clubId);
    return perms.includes(PermissionCatalog.CLUB_MEMBER_MANAGE);
  }
}

export const relationCommandProvider = {
  provide: RELATION_COMMAND_USE_CASE,
  useFactory: (
    store: RelationCommandStore,
    clubs: ClubStore,
    casdoor: CasdoorGroupPort,
    scheduler: JobSchedulerPort,
    notifications: NotificationPort,
    permissions: CurrentPermissionsPort,
  ) => new RelationCommandUseCase(store, clubs, casdoor, scheduler, notifications, permissions),
  inject: [
    RELATION_COMMAND_STORE,
    CLUB_STORE,
    CASDOOR_GROUP_PORT,
    JOB_SCHEDULER,
    NOTIFICATION_PORT,
    CURRENT_PERMISSIONS_PORT,
  ],
};

function newId(prefix: IdPrefix): string {
  return `${prefix}-${randomUUID()}`;
}
