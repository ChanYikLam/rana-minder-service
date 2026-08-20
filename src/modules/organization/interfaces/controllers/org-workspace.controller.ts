/**
 * org 工作空间控制器（§4 GET /api/org/:clubId/context、dashboard；§15.1 org 域
 * 关系命令/预约命令/批次入口）。
 *
 * 语义（ORG-038/040）：管理工作台进入前须选定当前有权社团；逐请求重算权限。
 */

import { Body, Controller, Get, HttpCode, Inject, Param, Post } from '@nestjs/common';

import { Actor, type RequestActor } from '../actor';
import type { OrgContextQuery } from '../../application/queries/org-context.query';
import type { RelationCommandUseCase } from '../../application/commands/relation-command.use-case';
import type { AppointmentCommandUseCase } from '../../application/commands/appointment-command.use-case';
import {
  APPOINTMENT_COMMAND_USE_CASE,
  CLUB_STORE,
  CURRENT_PERMISSIONS_PORT,
  ORG_CONTEXT_QUERY,
  RELATION_COMMAND_USE_CASE,
  type ClubStore,
  type CurrentPermissionsPort,
} from '../../application/ports';
import { orgError } from '../../domain/types';
import {
  CancelCommandDto,
  CreateAppointmentCommandDto,
  ReconfirmAppointmentDto,
  SubmitRelationCommandDto,
} from '../dto';

@Controller('api/org')
export class OrgWorkspaceController {
  constructor(
    @Inject(ORG_CONTEXT_QUERY) private readonly contextQuery: OrgContextQuery,
    @Inject(RELATION_COMMAND_USE_CASE) private readonly relationCommands: RelationCommandUseCase,
    @Inject(APPOINTMENT_COMMAND_USE_CASE) private readonly appointments: AppointmentCommandUseCase,
    @Inject(CLUB_STORE) private readonly clubs: ClubStore,
    @Inject(CURRENT_PERMISSIONS_PORT) private readonly permissions: CurrentPermissionsPort,
  ) {}

  @Get(':clubId/context')
  async context(@Actor() actor: RequestActor, @Param('clubId') clubId: string) {
    return this.contextQuery.context(actor.userId, clubId);
  }

  @Get(':clubId/dashboard')
  async dashboard(@Actor() actor: RequestActor, @Param('clubId') clubId: string) {
    return this.contextQuery.dashboard(actor.userId, clubId);
  }

  // ----- 关系命令 -----

  @Post(':clubId/members/transition')
  @HttpCode(201)
  async submitRelation(
    @Actor() actor: RequestActor,
    @Param('clubId') clubId: string,
    @Body() dto: SubmitRelationCommandDto,
  ) {
    this.requireNonEmpty(dto.type, 'type');
    return this.relationCommands.submit(
      {
        clubId,
        type: dto.type as never,
        subjectId: dto.subjectId,
        targetGroups: dto.targetGroups,
        objectVersion: dto.objectVersion,
        idempotencyKey: dto.idempotencyKey,
        submittedBy: actor.userId,
      },
      new Date(),
    );
  }

  @Post(':clubId/relation-commands/:commandId/readback')
  @HttpCode(200)
  async readback(@Actor() _actor: RequestActor, @Param('commandId') _commandId: string) {
    // 回读收口由系统/对账任务驱动；此处通过内存 Casdoor 桩仿真一次写后回读
    throw orgError.forbidden('回读收口应经系统关系任务驱动，不对普通请求开放（ORG-027）');
  }

  @Post(':clubId/members/transition/retry')
  @HttpCode(200)
  async retryRelation(@Actor() actor: RequestActor, @Body() dto: { commandId: string }) {
    if (dto?.commandId === undefined) throw orgError.validation('缺少 commandId');
    return this.relationCommands.manualRetry({
      commandId: dto.commandId,
      actor: actor.userId,
      now: new Date(),
    });
  }

  // ----- 预约命令 -----

  @Get(':clubId/members/appointments')
  async listAppointments(@Actor() actor: RequestActor, @Param('clubId') clubId: string) {
    const club = await this.clubs.findById(clubId);
    if (club === null) throw orgError.notVisible(`社团空间不存在（${clubId}）`);
    // 逐请求重算权限：无当前有效权限不得枚举预约（ORG-038/023）
    const perms = await this.permissions.effectiveForClub(actor.userId, clubId);
    if (perms.length === 0) {
      throw orgError.forbidden(`用户 ${actor.userId} 无权查看社团「${club.name}」预约（ORG-038）`);
    }
    const items = await this.appointments['listForClub'](clubId);
    return { items };
  }

  @Post(':clubId/members/appointments')
  @HttpCode(201)
  async createAppointment(
    @Actor() actor: RequestActor,
    @Param('clubId') clubId: string,
    @Body() dto: CreateAppointmentCommandDto,
  ) {
    return this.appointments.create({
      clubId,
      type: dto.type,
      content: {
        subjectId: dto.subjectId,
        departmentGroup: toStableRef(dto.departmentGroupId),
        positionGroup: toStableRef(dto.positionGroupId),
        revokeFromGroup: toStableRef(dto.revokeFromGroupId),
      },
      plannedAt: dto.plannedAt,
      initiator: actor.userId,
      initiatorRoleAtCreate: actor.userId,
      now: new Date(),
    });
  }

  @Post(':clubId/members/appointments/:commandId/cancel')
  @HttpCode(200)
  async cancelAppointment(
    @Actor() actor: RequestActor,
    @Param('commandId') commandId: string,
    @Body() dto: CancelCommandDto,
  ) {
    return this.appointments.cancel({
      commandId,
      actor: actor.userId,
      reason: dto.reason,
      now: new Date(),
    });
  }

  @Post(':clubId/members/appointments/:commandId/reconfirm')
  @HttpCode(200)
  async reconfirmAppointment(
    @Actor() actor: RequestActor,
    @Param('commandId') commandId: string,
    @Body() dto: ReconfirmAppointmentDto,
  ) {
    return this.appointments.reconfirm({
      commandId,
      actor: actor.userId,
      newExecTime: dto.newExecTime,
      now: new Date(),
    });
  }

  private requireNonEmpty(value: string, field: string): void {
    if (value.trim() === '') throw orgError.validation(`字段 ${field} 不能为空`);
  }
}

function toStableRef(raw: string | undefined): { owner: string; name: string } | undefined {
  if (raw === undefined || raw === '') return undefined;
  const parts = raw.split('/');
  if (parts.length === 2) return { owner: parts[0], name: parts[1] };
  return { owner: 'builtin', name: raw };
}
