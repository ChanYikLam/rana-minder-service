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
import { IdPrefix, OrgDomainError, orgError } from '../../domain/types';
import {
  CASDOOR_GROUP_PORT,
  CLUB_STORE,
  CURRENT_PERMISSIONS_PORT,
  GROUP_MAPPING_REGISTRY,
  JOB_SCHEDULER,
  NOTIFICATION_PORT,
  RELATION_COMMAND_AUDIT_PORT,
  RELATION_COMMAND_STORE,
  RELATION_COMMAND_USE_CASE,
  type CasdoorGroupPort,
  type ClubStore,
  type CurrentPermissionsPort,
  type GroupMappingRegistry,
  type JobSchedulerPort,
  type NotificationPort,
  type RelationCommandAuditEntry,
  type RelationCommandAuditPort,
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
    private readonly audit: RelationCommandAuditPort,
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
    // 副作用落痕在实体动作（save/enqueue）之后，保证留痕与事实一致
    await this.dispatchSideEffects('submit', command.status, result, now);
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
    // 目标 Group 缺失时 `getGroupMembers` 与 readback 端口一致返回 []（空成员集 →
    // present=false），不会抛裸 Error；端口级异常（网络/权限）统一收敛为可重试的
    // 领域错误，保证 submit 失败路径可控，与 readback 容错语义一致。
    interface AnnotatedStep {
      index: number;
      ref: GroupStableRef;
      kind: 'add' | 'remove';
      purpose: GroupPurpose | null;
      present: boolean;
    }
    let annotated: AnnotatedStep[];
    try {
      annotated = await Promise.all(
        input.targetGroups.map(async (tg, index) => {
          // 失败来源拆分：用途登记读取与成员实况回读分别收敛，避免错误信息张冠李戴；
          // 两者都携带根因（cause），供日志/追踪定位，不掩盖开发期 Bug。
          let purpose: GroupPurpose | null;
          try {
            purpose = await this.lookupGroupPurpose(tg.ref);
          } catch (cause) {
            throw withCause(
              orgError.precondition('读取目标 Group 用途登记失败，请稍后重试（ORG-027）'),
              cause,
            );
          }
          let members: readonly string[];
          try {
            members = await this.casdoor.getGroupMembers(tg.ref);
          } catch (cause) {
            throw withCause(
              orgError.precondition('回读目标 Group 实况失败，请稍后重试（ORG-027）'),
              cause,
            );
          }
          const present = members.includes(input.subjectId);
          return {
            index,
            ref: { owner: tg.ref.owner, name: tg.ref.name } as GroupStableRef,
            kind: tg.kind,
            purpose,
            present,
          } as AnnotatedStep;
        }),
      );
    } catch (cause) {
      // 已收敛的领域错误原样上抛；其余（编排层意外异常）统一收敛并携带根因
      if (cause instanceof OrgDomainError) throw cause;
      throw withCause(
        orgError.precondition('读取目标 Group 用途/成员实况失败，请稍后重试（ORG-027）'),
        cause,
      );
    }

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
    // 社团 Group 缺失属配置异常：显式存在性校验，避免误报"用户不是成员"（ORG-013）
    const group = await this.casdoor.getGroupByRef(clubGroup);
    if (group === null || group.deleted || !group.readable) {
      throw orgError.precondition(
        `社团 Group ${clubGroup.owner}/${clubGroup.name} 不存在或不可读，无法校验成员前提（ORG-013）`,
      );
    }
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
    // 负责人 Group 缺失属配置异常：fail-closed，不静默按"空负责人集合"放行（ORG-024/013）
    const group = await this.casdoor.getGroupByRef(leaderGroup);
    if (group === null || group.deleted || !group.readable) {
      throw orgError.precondition(
        `负责人职位 Group ${leaderGroup.owner}/${leaderGroup.name} 不存在或不可读，无法校验连续性（ORG-024/ORG-013）`,
      );
    }
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

    const previousStatus = command.status;
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
    // 状态机声明副作用显式落点：审计留痕 + 通知（notify_subject_admins 在
    // dispatch 内发送，dedupKey 与原实现一致，不重复发）
    await this.dispatchSideEffects(event, previousStatus, result, input.now);
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
      await this.dispatchSideEffects('write_started', 'pending_execution', started, input.now);
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
    const statusBeforeRetry = command.status;
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
    // 两次迁移的副作用都留痕：create_manual_retry（重新鉴权+登记新尝试）与
    // manual_retry_executed（重读实况后回到待执行）
    await this.dispatchSideEffects('create_manual_retry', statusBeforeRetry, result, input.now);
    await this.dispatchSideEffects(
      'manual_retry_executed',
      result.command.status,
      reexecute,
      input.now,
    );
    return reexecute.command;
  }

  /**
   * 状态机声明的副作用显式落点（SRS-SM-ORG-002 requiredSideEffects；ORG-027）。
   *
   * 每次状态迁移返回的 requiredSideEffects 不再丢弃：
   * 1. 全部标签逐条写入审计留痕端口（append-only，可验证落点）——审计留痕
   *    覆盖验收的事实基线（含 save_command_audit/status_audit/
   *    write_immutable_relation_history/record_attempt 等）；
   * 2. notify / alarm 类标签同时真实发送通知（IFC-TX-002：涉权益转换同事务
   *    留痕通知事实）；
   * 3. 操作型标签的实体动作由各自执行器承担、此处留痕证明已按声明发生：
   *    - enqueue_execution_task/create_readback_task：调用方紧随迁移显式登记；
   *    - issue_or_revoke_permissions：Casdoor Group 成员变更即权限本体
   *      （GOV-007），经执行器写入且回读确认后才到达 readback_confirmed 收口；
   *    - keep_original_relation/reauthorize_before_retry/readback_actual_relation：
   *      用例流程保证的约束性动作；
   *    - compensate_in_order:<stepIds>：补偿顺序声明落痕（detail 携带逆序
   *      stepId 序列），供执行器与审计核对。
   *
   * 审计写入失败须上抛（不得静默）：留痕缺失等同该迁移未通过验收口径。
   */
  private async dispatchSideEffects(
    eventType: string,
    fromStatus: string,
    result: { command: RelationCommand; requiredSideEffects: readonly string[] },
    now: Date,
  ): Promise<void> {
    const { command } = result;
    const occurredAt = now.toISOString();
    for (const sideEffect of result.requiredSideEffects) {
      const detail = sideEffect.startsWith(COMPENSATE_IN_ORDER_PREFIX)
        ? {
            compensateOrder: sideEffect
              .slice(COMPENSATE_IN_ORDER_PREFIX.length)
              .split(',')
              .filter((s) => s.length > 0),
          }
        : null;
      const entry: RelationCommandAuditEntry = {
        commandId: command.id,
        clubId: command.clubId,
        eventType,
        fromStatus,
        toStatus: command.status,
        sideEffect,
        detail,
        occurredAt,
      };
      await this.audit.record(entry);

      switch (sideEffect) {
        case 'notify_subject_admins':
          // 回读确认生效 → 通知主体本人（dedupKey 与既有口径一致）
          await this.notifications.save({
            kind: 'member',
            toUserIds: [command.subjectId],
            clubId: command.clubId,
            title: '关系变更已生效',
            body: `关系命令 ${command.id} 已回读确认生效`,
            dedupKey: `relation-confirmed:${command.id}`,
          });
          break;
        case 'notify_operator_admin':
          await this.notifications.save({
            kind: 'system',
            toUserIds: [],
            clubId: command.clubId,
            title: '关系命令未生效，原关系保持有效',
            body: `关系命令 ${command.id} 现状 ${command.status}：${command.failureReason ?? '无失败原因记录'}`,
            dedupKey: `relation-operator:${command.id}:${command.status}`,
          });
          break;
        case 'alarm_operator_admin':
          await this.notifications.save({
            kind: 'system',
            toUserIds: [],
            clubId: command.clubId,
            title: '【告警】复合关系部分写入，进入补偿',
            body: `关系命令 ${command.id} 部分写入，按逆序补偿中（第 ${command.attemptCount} 次尝试）`,
            dedupKey: `relation-alarm:${command.id}:${command.attemptCount}`,
          });
          break;
        default:
          break; // 其余标签仅审计落痕
      }
    }
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
    audit: RelationCommandAuditPort,
  ) =>
    new RelationCommandUseCase(
      store,
      clubs,
      casdoor,
      mappingRegistry,
      scheduler,
      notifications,
      permissions,
      audit,
    ),
  inject: [
    RELATION_COMMAND_STORE,
    CLUB_STORE,
    CASDOOR_GROUP_PORT,
    GROUP_MAPPING_REGISTRY,
    JOB_SCHEDULER,
    NOTIFICATION_PORT,
    CURRENT_PERMISSIONS_PORT,
    RELATION_COMMAND_AUDIT_PORT,
  ],
};

function newId(prefix: IdPrefix): string {
  return `${prefix}-${randomUUID()}`;
}

/** partial_write 副作用标签前缀：compensate_in_order:<逆序 stepId 逗号序列> */
const COMPENSATE_IN_ORDER_PREFIX = 'compensate_in_order:';

/**
 * 把原始异常附加为 `cause`（保留根因供日志/追踪定位），
 * message 保持用户可读、不泄漏内部细节。
 */
function withCause<T extends Error>(err: T, cause: unknown): T {
  (err as Error & { cause?: unknown }).cause = cause;
  return err;
}
