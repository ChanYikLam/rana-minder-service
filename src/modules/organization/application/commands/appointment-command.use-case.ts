/**
 * ORG-003 预约管理命令命令用例（SRS-SM-ORG-003 §4.3）。
 *
 * HTTP 端点：§15.1 org 域预约命令（POST /api/org/:clubId/members/appointments*）。
 *
 * 关键语义：
 * - 计划执行 + 调度：预约任命/免职/调岗支持未来时间；调度器按计划执行、单执行
 *   租约、调度幂等（ORG-039）。
 * - 执行前重验发起人权限/对象/社团状态/连续性/命令版本；发起人失权→暂停待重新
 *   确认；业务前置条件失效→暂停待处置（不得自动执行/重试/部分写入）（ORG-039）。
 * - 取消与调度执行按同一命令版本竞争只一个成功；执行中/已生效后拒绝通用取消
 *   （ORG-039）。
 */

import { randomUUID } from 'node:crypto';

import type { AppointmentCommand } from '../../domain/models/appointment-command';
import { createAppointmentCommand } from '../../domain/models/appointment-command';
import { PermissionCatalog } from '../../domain/models/permission-template';
import type { RelationCommand } from '../../domain/models/relation-command';
import { AppointmentCommandStateMachine } from '../../domain/state-machines/appointment-command.state-machine';
import type { AppointmentCommandType } from '../../domain/types';
import { IdPrefix, orgError } from '../../domain/types';
import { type RelationCommandUseCase } from './relation-command.use-case';
import {
  APPOINTMENT_COMMAND_STORE,
  APPOINTMENT_COMMAND_USE_CASE,
  CASDOOR_GROUP_PORT,
  CLUB_STORE,
  CURRENT_PERMISSIONS_PORT,
  JOB_SCHEDULER,
  NOTIFICATION_PORT,
  RELATION_COMMAND_USE_CASE,
  type AppointmentCommandStore,
  type CasdoorGroupPort,
  type ClubStore,
  type CurrentPermissionsPort,
  type JobSchedulerPort,
  type NotificationPort,
} from '../ports';

export interface AppointmentContent {
  readonly subjectId: string;
  readonly departmentGroup?: { owner: string; name: string };
  readonly positionGroup?: { owner: string; name: string };
  readonly revokeFromGroup?: { owner: string; name: string };
}

export class AppointmentCommandUseCase {
  private readonly stateMachine = new AppointmentCommandStateMachine();

  constructor(
    private readonly store: AppointmentCommandStore,
    private readonly clubs: ClubStore,
    private readonly permissions: CurrentPermissionsPort,
    private readonly relationCommands: RelationCommandUseCase,
    private readonly scheduler: JobSchedulerPort,
    private readonly notifications: NotificationPort,
    private readonly casdoor: CasdoorGroupPort,
  ) {
    // 关系命令回读收口回调：关系命令确认/失败后推进预约命令状态机（executing → effective / exec_failed_pending_retry）
    this.relationCommands.setReadbackSink((rel) => this.settleFromRelationCommand(rel));
  }

  async create(input: {
    clubId: string;
    type: AppointmentCommandType;
    content: AppointmentContent;
    plannedAt: string;
    initiator: string;
    initiatorRoleAtCreate: string;
    now: Date;
  }): Promise<AppointmentCommand> {
    const club = await this.clubs.findById(input.clubId);
    if (club === null) throw orgError.notVisible(`社团空间不存在（${input.clubId}）`);
    if (club.status !== 'enabled') {
      throw orgError.precondition(`社团当前 ${club.status}，禁止预约任命（ORG-001）`);
    }
    if (Date.parse(input.plannedAt) <= input.now.getTime()) {
      throw orgError.validation('预约执行时间必须晚于当前时间（ORG-039）');
    }
    // 权限校验：发起人须有预约管理权限（ORG-039）
    const perms = await this.permissions.effectiveForClub(input.initiator, input.clubId);
    if (!perms.includes(PermissionCatalog.CLUB_APPOINTMENT_MANAGE)) {
      throw orgError.forbidden('发起人无预约管理权限（ORG-039）');
    }

    const command = createAppointmentCommand({
      id: newId(IdPrefix.APPOINTMENT_COMMAND),
      clubId: input.clubId,
      type: input.type,
      content: { ...input.content },
      initiator: input.initiator,
      initiatorRoleAtCreate: input.initiatorRoleAtCreate,
      plannedAt: input.plannedAt,
      now: input.now,
    });
    const result = this.stateMachine.transition({
      command,
      event: 'create',
      now: input.now,
      actor: input.initiator,
      actorRole: input.initiatorRoleAtCreate,
      facts: {},
    });
    await this.store.save(result.command);
    await this.scheduler.enqueue({
      taskId: `tsk-appt-${command.id}`,
      kind: 'appointment_due',
      refId: command.id,
      scheduleType: 'at',
      at: input.plannedAt,
      idempotencyKey: `appointment-due:${command.id}`,
      leaseHolder: null,
    });
    return result.command;
  }

  async scheduleExecute(input: {
    commandId: string;
    clubId: string;
    actor: string;
    now: Date;
  }): Promise<AppointmentCommand> {
    const command = await this.requireCommand(input.commandId);
    if (input.clubId !== command.clubId) {
      throw orgError.scopeMismatch(
        `URL 社团作用域 ${input.clubId} 与预约命令实际社团 ${command.clubId} 不一致（IFC-ERR-004）`,
      );
    }
    // 显式到期判断：未到达执行时间给出正确前置条件错误，而非误导性的租约冲突 409
    const execTime =
      command.status === 'reconfirmed_pending_execution'
        ? (command.newExecTime ?? command.plannedAt)
        : command.plannedAt;
    if (Date.parse(execTime) > input.now.getTime()) {
      throw orgError.precondition('尚未到达执行时间（ORG-039）');
    }
    const taskId = `tsk-appt-${command.id}`;
    const leased = await this.scheduler.acquireLease(taskId, input.actor, input.now);
    if (!leased) {
      throw orgError.stateConflict('调度器已取得执行租约，禁止重复执行（单执行租约，ORG-039）');
    }

    try {
      const initiatorHasRights = await this.permissions
        .effectiveForClub(command.initiator, command.clubId)
        .then((p) => p.includes(PermissionCatalog.CLUB_APPOINTMENT_MANAGE));

      const preconditions = await this.evaluatePreconditions(command);

      const result = this.stateMachine.transition({
        command,
        event: 'schedule_execute',
        now: input.now,
        actor: input.actor,
        actorRole: await this.permissions.primaryRoleAt(input.actor, command.clubId),
        facts: {
          due: true,
          initiatorHasRights,
          preconditions,
        },
      });

      if (result.command.status === 'executing') {
        await this.createRelationExecution(result.command, input.now);
      } else {
        // 未进入执行（发起人失权/前置条件失效暂停）：任务已完成本轮使命，释放租约
        // 避免旧任务租约残留阻塞 reconfirm 后的人工/调度再执行（ORG-039 单执行租约）
        await this.scheduler.complete(taskId);
      }
      await this.store.save(result.command);
      return result.command;
    } catch (err) {
      // 执行过程中异常：释放租约以便后续重试，不让租约永久滞留（ORG-039）
      await this.scheduler.fail(taskId, err instanceof Error ? err.message : String(err));
      throw err;
    }
  }

  async reconfirm(input: {
    commandId: string;
    clubId: string;
    actor: string;
    newExecTime?: string;
    now: Date;
  }): Promise<AppointmentCommand> {
    const command = await this.requireCommand(input.commandId);
    if (input.clubId !== command.clubId) {
      throw orgError.scopeMismatch(
        `URL 社团作用域 ${input.clubId} 与预约命令实际社团 ${command.clubId} 不一致（IFC-ERR-004）`,
      );
    }
    const actorAuthorized = await this.isAuthorizedForCommand(input.actor, command);
    const actorRole = await this.permissions.primaryRoleAt(input.actor, command.clubId);
    const preconditions = await this.evaluatePreconditions(command);
    const result = this.stateMachine.transition({
      command,
      event: 'reconfirm',
      now: input.now,
      actor: input.actor,
      actorRole,
      facts: {
        confirmerAuthorized: actorAuthorized,
        preconditions,
        newExecTime: input.newExecTime,
      },
    });
    await this.store.save(result.command);
    if (result.command.status === 'reconfirmed_pending_execution' && input.newExecTime) {
      await this.scheduler.enqueue({
        taskId: `tsk-appt-${command.id}`,
        kind: 'appointment_due',
        refId: command.id,
        scheduleType: 'at',
        at: input.newExecTime,
        idempotencyKey: `appointment-due:${command.id}:${result.command.scheduleVersion}`,
        leaseHolder: null,
      });
    }
    return result.command;
  }

  async cancel(input: {
    commandId: string;
    clubId: string;
    actor: string;
    reason: string;
    now: Date;
  }): Promise<AppointmentCommand> {
    const command = await this.requireCommand(input.commandId);
    if (input.clubId !== command.clubId) {
      throw orgError.scopeMismatch(
        `URL 社团作用域 ${input.clubId} 与预约命令实际社团 ${command.clubId} 不一致（IFC-ERR-004）`,
      );
    }
    const actorAuthorized = await this.isAuthorizedForCommand(input.actor, command);
    const actorRole = await this.permissions.primaryRoleAt(input.actor, command.clubId);
    const result = this.stateMachine.transition({
      command,
      event: 'cancel',
      now: input.now,
      actor: input.actor,
      actorRole,
      facts: { cancellerAuthorized: actorAuthorized, reason: input.reason },
    });
    await this.store.save(result.command);
    return result.command;
  }

  async settleExecution(input: {
    commandId: string;
    success: boolean;
    reason: string;
    now: Date;
  }): Promise<AppointmentCommand> {
    const command = await this.requireCommand(input.commandId);
    const event = input.success ? 'execution_succeeded' : 'execution_failed';
    const result = this.stateMachine.transition({
      command,
      event,
      now: input.now,
      actor: 'system',
      actorRole: 'system',
      facts: { executionResult: input.success ? 'success' : 'failure', reason: input.reason },
    });
    await this.store.save(result.command);
    // 收口后释放单执行租约：成功移除任务，失败释放租约（保留任务供人工重试再次竞争）
    const taskId = `tsk-appt-${command.id}`;
    if (result.command.status === 'effective') {
      await this.scheduler.complete(taskId);
    } else {
      await this.scheduler.fail(taskId, input.reason);
    }
    return result.command;
  }

  async retryExecute(input: {
    commandId: string;
    clubId: string;
    actor: string;
    now: Date;
  }): Promise<AppointmentCommand> {
    const command = await this.requireCommand(input.commandId);
    if (input.clubId !== command.clubId) {
      throw orgError.scopeMismatch(
        `URL 社团作用域 ${input.clubId} 与预约命令实际社团 ${command.clubId} 不一致（IFC-ERR-004）`,
      );
    }
    // 人工重试同样遵循单执行租约（ORG-039）：已取得租约则禁止并发重执行
    const taskId = `tsk-appt-${command.id}`;
    const leased = await this.scheduler.acquireLease(taskId, input.actor, input.now);
    if (!leased) {
      throw orgError.stateConflict('调度器已取得执行租约，禁止重复执行（单执行租约，ORG-039）');
    }
    try {
      const actorAuthorized = await this.isAuthorizedForCommand(input.actor, command);
      if (!actorAuthorized) {
        throw orgError.forbidden('人工重试前须重新鉴权（ORG-039）');
      }
      // 重试前重验业务前置条件：条件未恢复不得自动重试（ORG-039）
      const preconditions = await this.evaluatePreconditions(command);
      if (!preconditions.every((p) => p.ok)) {
        throw orgError.precondition(
          '重试前置条件未满足，请先恢复条件再重试（ORG-039）',
          JSON.stringify(preconditions),
        );
      }
      const result = this.stateMachine.transition({
        command,
        event: 'retry_execute',
        now: input.now,
        actor: input.actor,
        actorRole: await this.permissions.primaryRoleAt(input.actor, command.clubId),
        facts: { confirmerAuthorized: actorAuthorized },
      });
      await this.createRelationExecution(result.command, input.now);
      await this.store.save(result.command);
      return result.command;
    } catch (err) {
      // 鉴权/前置条件/执行异常：释放租约，避免人工重试被永久阻塞（ORG-039）
      await this.scheduler.fail(taskId, err instanceof Error ? err.message : String(err));
      throw err;
    }
  }

  private async createRelationExecution(command: AppointmentCommand, now: Date): Promise<void> {
    const club = await this.clubs.findById(command.clubId);
    if (club === null) throw orgError.notVisible(`社团空间不存在（${command.clubId}）`);
    const content = command.content as unknown as AppointmentContent;
    const targetGroups: Array<{
      ref: { owner: string; name: string };
      kind: 'add' | 'remove';
    }> = [];
    if (command.type === 'appoint' || command.type === 'transfer') {
      if (content.departmentGroup) targetGroups.push({ ref: content.departmentGroup, kind: 'add' });
      if (content.positionGroup) targetGroups.push({ ref: content.positionGroup, kind: 'add' });
    }
    if (command.type === 'revoke' || command.type === 'transfer') {
      if (content.revokeFromGroup)
        targetGroups.push({ ref: content.revokeFromGroup, kind: 'remove' });
    }
    const rel = await this.relationCommands.submit(
      {
        clubId: command.clubId,
        type:
          command.type === 'transfer'
            ? 'transfer_position'
            : command.type === 'appoint'
              ? 'appoint_position'
              : 'revoke_position',
        subjectId: content.subjectId,
        targetGroups,
        objectVersion: club.version,
        idempotencyKey: `appointment:${command.id}:v${command.scheduleVersion}`,
        submittedBy: command.initiator,
      },
      now,
    );
    // 关联关系命令（回读收口由关系命令侧驱动并回调 settleExecution）
    command.relationCommandId = rel.id;
  }

  async listForClub(clubId: string): Promise<AppointmentCommand[]> {
    return this.store.listByClub(clubId);
  }

  private async requireCommand(commandId: string): Promise<AppointmentCommand> {
    const command = await this.store.findById(commandId);
    if (command === null) throw orgError.notVisible(`预约命令不存在（${commandId}）`);
    return command;
  }

  private async isAuthorizedForCommand(
    actor: string,
    command: AppointmentCommand,
  ): Promise<boolean> {
    const perms = await this.permissions.effectiveForClub(actor, command.clubId);
    return perms.includes(PermissionCatalog.CLUB_APPOINTMENT_MANAGE);
  }

  /** 关系命令回读收口回调：推进预约命令状态机（ORG-027 写后回读 → ORG-039 生效收口） */
  private async settleFromRelationCommand(rel: RelationCommand): Promise<void> {
    const appt = await this.store.findByRelationCommandId(rel.id);
    if (appt === null || appt.status !== 'executing') return;
    const success = rel.status === 'readback_confirmed';
    const now = rel.confirmedAt !== null ? new Date(rel.confirmedAt) : new Date();
    await this.settleExecution({
      commandId: appt.id,
      success,
      reason: success
        ? '关系命令回读确认生效'
        : (rel.failureReason ?? '关系命令失败，原关系保持有效'),
      now,
    });
  }

  private async evaluatePreconditions(
    command: AppointmentCommand,
  ): Promise<Array<{ name: string; ok: boolean }>> {
    const club = await this.clubs.findById(command.clubId);
    const content = command.content as unknown as AppointmentContent;
    // 目标主体必须是社团 Group 成员才能被任命/免职/调岗（ORG-039）
    let subjectIsMember = false;
    if (content.subjectId && club?.clubGroup) {
      try {
        const members = await this.casdoor.getGroupMembers(club.clubGroup);
        subjectIsMember = members.includes(content.subjectId);
      } catch {
        subjectIsMember = false; // 目标 Group 不可读按不满足处理，不得放行
      }
    }
    return [
      { name: 'club_enabled', ok: club !== null && club.status === 'enabled' },
      { name: 'subject_member', ok: subjectIsMember },
      // 命令版本/调度周期由状态机与单执行租约共同保证（ORG-039）：scheduleVersion
      // 在 create/schedule_execute/reconfirm 时自增，调度幂等通过 taskId 与租约锁定，
      // 此处无需再重复校验版本（避免恒真死守卫误导）。
    ];
  }
}

export const appointmentCommandProvider = {
  provide: APPOINTMENT_COMMAND_USE_CASE,
  useFactory: (
    store: AppointmentCommandStore,
    clubs: ClubStore,
    permissions: CurrentPermissionsPort,
    relationCommands: RelationCommandUseCase,
    scheduler: JobSchedulerPort,
    notifications: NotificationPort,
    casdoor: CasdoorGroupPort,
  ) =>
    new AppointmentCommandUseCase(
      store,
      clubs,
      permissions,
      relationCommands,
      scheduler,
      notifications,
      casdoor,
    ),
  inject: [
    APPOINTMENT_COMMAND_STORE,
    CLUB_STORE,
    CURRENT_PERMISSIONS_PORT,
    RELATION_COMMAND_USE_CASE,
    JOB_SCHEDULER,
    NOTIFICATION_PORT,
    CASDOOR_GROUP_PORT,
  ],
};

function newId(prefix: IdPrefix): string {
  return `${prefix}-${randomUUID()}`;
}
