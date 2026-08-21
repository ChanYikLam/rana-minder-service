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
  ) {}

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
    if (!perms.includes('club:appointment:manage')) {
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
    actor: string;
    now: Date;
  }): Promise<AppointmentCommand> {
    const command = await this.requireCommand(input.commandId);
    const leased = await this.scheduler.acquireLease(
      `tsk-appt-${command.id}`,
      input.actor,
      input.now,
    );
    if (!leased) {
      throw orgError.stateConflict('调度器已取得执行租约，禁止重复执行（单执行租约，ORG-039）');
    }

    const initiatorHasRights = await this.permissions
      .effectiveForClub(command.initiator, command.clubId)
      .then((p) => p.includes('club:appointment:manage'));

    const preconditions = await this.evaluatePreconditions(command);

    const result = this.stateMachine.transition({
      command,
      event: 'schedule_execute',
      now: input.now,
      actor: input.actor,
      facts: {
        due: true,
        initiatorHasRights,
        preconditions,
      },
    });

    if (result.command.status === 'executing') {
      await this.createRelationExecution(result.command, input.now);
    }
    await this.store.save(result.command);
    return result.command;
  }

  async reconfirm(input: {
    commandId: string;
    actor: string;
    newExecTime?: string;
    now: Date;
  }): Promise<AppointmentCommand> {
    const command = await this.requireCommand(input.commandId);
    const actorAuthorized = await this.isAuthorizedForCommand(input.actor, command);
    const preconditions = await this.evaluatePreconditions(command);
    const result = this.stateMachine.transition({
      command,
      event: 'reconfirm',
      now: input.now,
      actor: input.actor,
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
    actor: string;
    reason: string;
    now: Date;
  }): Promise<AppointmentCommand> {
    const command = await this.requireCommand(input.commandId);
    const actorAuthorized = await this.isAuthorizedForCommand(input.actor, command);
    const result = this.stateMachine.transition({
      command,
      event: 'cancel',
      now: input.now,
      actor: input.actor,
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
      facts: { executionResult: input.success ? 'success' : 'failure', reason: input.reason },
    });
    await this.store.save(result.command);
    return result.command;
  }

  async retryExecute(input: {
    commandId: string;
    actor: string;
    now: Date;
  }): Promise<AppointmentCommand> {
    const command = await this.requireCommand(input.commandId);
    // 人工重试同样遵循单执行租约（ORG-039）：已取得租约则禁止并发重执行
    const leased = await this.scheduler.acquireLease(
      `tsk-appt-${command.id}`,
      input.actor,
      input.now,
    );
    if (!leased) {
      throw orgError.stateConflict('调度器已取得执行租约，禁止重复执行（单执行租约，ORG-039）');
    }
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
      facts: { confirmerAuthorized: actorAuthorized },
    });
    await this.createRelationExecution(result.command, input.now);
    await this.store.save(result.command);
    return result.command;
  }

  private async createRelationExecution(command: AppointmentCommand, now: Date): Promise<void> {
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
        objectVersion: command.createdVersion,
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
    return perms.includes('club:appointment:manage');
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
      // 命令版本须已进入有效调度周期（至少完成一次编排）才能执行（ORG-039）
      { name: 'command_version', ok: command.scheduleVersion >= command.createdVersion },
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
