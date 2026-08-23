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
import type {
  GroupPurpose,
  GroupStableRef,
  RelationCommandType,
  RelationWriteStep,
} from '../../domain/types';
import { IdPrefix, orgError } from '../../domain/types';
import {
  CASDOOR_GROUP_PORT,
  CLUB_STORE,
  CURRENT_PERMISSIONS_PORT,
  GROUP_MAPPING_REGISTRY,
  JOB_SCHEDULER,
  NOTIFICATION_PORT,
  RELATION_COMMAND_STORE,
  RELATION_COMMAND_USE_CASE,
  type CasdoorGroupPort,
  type ClubStore,
  type CurrentPermissionsPort,
  type GroupMappingRegistry,
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
  /**
   * 仅用于预约命令到期调度执行的内链路：预约命令创建时已校验
   * CLUB_APPOINTMENT_MANAGE，实际 Group 关系变更是系统按已批准的预约内容执行，
   * 不再要求提交者同时拥有 CLUB_MEMBER_MANAGE（ORG-027、ORG-039）。
   */
  skipMemberManageCheck?: boolean;
}

export class RelationCommandUseCase {
  private readonly stateMachine = new RelationCommandStateMachine();
  /** 回读收口回调（预约命令侧订阅：关系命令确认/失败后推进预约状态机） */
  private readbackSink: ((command: RelationCommand) => Promise<void>) | null = null;

  constructor(
    private readonly store: RelationCommandStore,
    private readonly clubs: ClubStore,
    private readonly casdoor: CasdoorGroupPort,
    private readonly mappingRegistry: GroupMappingRegistry,
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

    // 权限校验：直接提交须有成员/关系管理权限；预约命令调度执行内链路已在前置
    // 预约创建时校验 CLUB_APPOINTMENT_MANAGE，此处跳过二次成员权限要求（ORG-027/039）
    if (input.skipMemberManageCheck !== true) {
      const perms = await this.permissions.effectiveForClub(input.submittedBy, input.clubId);
      if (!perms.includes(PermissionCatalog.CLUB_MEMBER_MANAGE)) {
        throw orgError.forbidden('提交者无成员关系管理权限（ORG-027）');
      }
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

    const steps = await this.buildSteps(input, now);
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
   * 排序（CAS-Q-001 方案 A，CAS-WR-013）：
   * - 全部 `remove` 必须先于 `add`（先撤销再授予），避免临时特权窗口扩大。
   * - `add` 步内按 Group 用途升序执行：club（基础/低权限）→ department → position
   *   （具体/高权限），逐级收敛；未登记用途的 Group 视为最高风险，置末。
   *
   * 原关系快照（ORG-027）：`originalRelation` 在提交前回读 Casdoor 实际成员实况，
   * `result: 'confirmed'` 表示主体当前已是该 Group 成员，`'failed'` 表示尚未是。
   * 这是补偿/回退语义与不可变历史的事实基线。
   */
  private async buildSteps(
    input: SubmitRelationCommandInput,
    _now: Date,
  ): Promise<{
    original: RelationWriteStep[];
    target: RelationWriteStep[];
  }> {
    // 1) 解析每步的 Group 用途与当前成员实况（并发回读）
    const annotated = await Promise.all(
      input.targetGroups.map(async (tg, index) => {
        const purpose = await this.lookupGroupPurpose(tg.ref);
        // 目标 Group 缺失时优雅降级为「空成员集 + 用途 null」：与 readback
        // 端口（缺失返回 []）容错语义一致，避免在 submit 路径抛裸 Error
        const group = await this.casdoor.getGroupByRef(tg.ref);
        const members = group === null ? [] : group.memberIds;
        const present = members.includes(input.subjectId);
        return {
          index,
          ref: { owner: tg.ref.owner, name: tg.ref.name } as GroupStableRef,
          kind: tg.kind,
          purpose,
          present,
        };
      }),
    );

    // 2) 排序：remove 优先；同 kind 内 add 按用途升序
    const ordered = annotated
      .map((a) => ({
        stepId: `step-${a.index}`,
        kind: a.kind === 'add' ? ('add_member' as const) : ('remove_member' as const),
        targetGroup: a.ref,
        subjectId: input.subjectId,
        idempotencyKey: `${input.idempotencyKey}:${a.index}`,
        order: this.orderFor(a.kind, a.purpose),
        purpose: a.purpose,
        present: a.present,
      }))
      .sort((a, b) => a.order - b.order);

    // 3) 目标关系图（执行计划）：不携带运行时 result
    const target: RelationWriteStep[] = ordered.map((s) => ({
      stepId: s.stepId,
      kind: s.kind,
      targetGroup: s.targetGroup,
      subjectId: s.subjectId,
      idempotencyKey: s.idempotencyKey,
      order: s.order,
      attemptCount: 0,
    }));

    // 4) 原关系快照：回读 Casdoor 实况；'confirmed'=当前已是成员，'failed'=当前不是
    const original: RelationWriteStep[] = ordered.map((s) => ({
      stepId: s.stepId,
      kind: s.kind,
      targetGroup: s.targetGroup,
      subjectId: s.subjectId,
      idempotencyKey: s.idempotencyKey,
      order: s.order,
      attemptCount: 0,
      result: s.present ? ('confirmed' as const) : ('failed' as const),
    }));

    return { original, target };
  }

  /**
   * `remove` 必须先于 `add`（rank 0/1），`add` 内按 Group 用途升序。
   * 用途未在 GroupMappingRegistry 中登记的 Group 视为未识别，按"最高风险"置末，
   * 避免无元数据的 Group 抢在受控 Group 之前执行。
   */
  private orderFor(kind: 'add' | 'remove', purpose: GroupPurpose | null): number {
    if (kind === 'remove') return 0;
    const PURPOSE_RANK: Readonly<Record<NonNullable<GroupPurpose>, number>> = {
      club: 1,
      department: 2,
      position: 3,
    };
    return purpose === null ? 4 : PURPOSE_RANK[purpose];
  }

  /** 用途未登记返回 null（视作未识别的最高风险 Group，由 orderFor 置末） */
  private async lookupGroupPurpose(ref: GroupStableRef): Promise<GroupPurpose | null> {
    const record = await this.mappingRegistry.findByRef(ref);
    return record?.purpose ?? null;
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
  async systemConfirmReadback(input: {
    commandId: string;
    clubId: string;
    now: Date;
  }): Promise<RelationCommand> {
    let command = await this.requireCommand(input.commandId);
    if (input.clubId !== command.clubId) {
      throw orgError.scopeMismatch(
        `URL 社团作用域 ${input.clubId} 与关系命令实际社团 ${command.clubId} 不一致（IFC-ERR-004）`,
      );
    }

    // 若尚未进入写入中，先触发 write_started 以记录 attemptCount 与 retryDeadline，
    // 否则 15 分钟有界自动重试窗口永远不会起算（ORG-027）。
    if (command.status === 'pending_execution') {
      const started = this.stateMachine.transition({
        command,
        event: 'write_started',
        now: input.now,
        facts: {},
      });
      command = started.command;
      await this.store.save(command);
    }

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
    mappingRegistry: GroupMappingRegistry,
    scheduler: JobSchedulerPort,
    notifications: NotificationPort,
    permissions: CurrentPermissionsPort,
  ) =>
    new RelationCommandUseCase(
      store,
      clubs,
      casdoor,
      mappingRegistry,
      scheduler,
      notifications,
      permissions,
    ),
  inject: [
    RELATION_COMMAND_STORE,
    CLUB_STORE,
    CASDOOR_GROUP_PORT,
    GROUP_MAPPING_REGISTRY,
    JOB_SCHEDULER,
    NOTIFICATION_PORT,
    CURRENT_PERMISSIONS_PORT,
  ],
};

function newId(prefix: IdPrefix): string {
  return `${prefix}-${randomUUID()}`;
}
