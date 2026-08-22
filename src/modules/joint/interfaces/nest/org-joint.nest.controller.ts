/**
 * 组织联合端点 Nest 适配控制器（interfaces/nest；JNT-001~006 管理面）。
 *
 * 路由（作用域由路径 clubId 冻结）：
 * - POST /api/org/:clubId/joint/activities                              发起联合活动
 * - POST /api/org/:clubId/joint/activities/:activityId/propose         提出拟参与
 * - POST /api/org/:clubId/joint/activities/:activityId/confirm         确认本轮参与
 * - POST /api/org/:clubId/joint/activities/:activityId/publish         公布
 * - POST /api/org/:clubId/joint/activities/:activityId/cancel          取消
 * - POST /api/org/:clubId/joint/activities/:activityId/begin-end       进入结束确认
 * - POST /api/org/:clubId/joint/activities/:activityId/end             结束
 * - POST /api/org/:clubId/joint/activities/:activityId/force-end       强制结束
 * - POST /api/org/:clubId/joint/activities/:activityId/participants/:participantClubId/withdraw
 * - POST /api/org/:clubId/joint/activities/:activityId/participants/:participantClubId/suspend
 * - POST /api/org/:clubId/joint/activities/:activityId/participants/:participantClubId/resume
 * - POST /api/org/:clubId/joint/activities/:activityId/channels/open    开放报名通道
 * - POST /api/org/:clubId/joint/activities/:activityId/channels/suspend
 * - POST /api/org/:clubId/joint/activities/:activityId/channels/resume
 * - POST /api/org/:clubId/joint/activities/:activityId/channels/extend
 * - POST /api/org/:clubId/joint/activities/:activityId/channels/close
 * - POST /api/org/:clubId/joint/activities/:activityId/channels/reopen
 * - POST /api/org/:clubId/joint/applications/:applicationId/interviews/schedule  安排面试
 * - POST /api/org/:clubId/joint/interviews/:interviewId/start|complete|void       面试流转
 * - POST /api/org/:clubId/joint/interviews/:interviewId/evaluations               记录评价
 * - POST /api/org/:clubId/joint/applications/:applicationId/conclusions           编辑社团结论
 * - POST /api/org/:clubId/joint/conclusions/:conclusionId/invite|restore
 * - GET  /api/org/:clubId/joint/activities/:activityId                           获取活动
 * - GET  /api/org/:clubId/joint/activities/:activityId/participants             列出参与社团
 * - GET  /api/org/:clubId/joint/activities/:activityId/applications             列出申请
 * - GET  /api/org/:clubId/joint/activities/:activityId/channel                  获取通道
 */

import { Body, Controller, Get, Inject, Param, Post, Req, UseGuards } from '@nestjs/common';

import { TRACE_CONTEXT } from '../../../../platform/observability/tracing/tokens';
import type { TraceContextAdapter } from '../../../../platform/observability/infrastructure/trace-context.adapter';
import { JOINT_CONTROLLER } from '../../tokens';
import type { JointController } from '../controllers/joint.controller';
import { JointAuthGuard } from './joint-auth.guard';
import { toHttpResponse, actorFromRequest } from './joint-response-mapper';
import { parseJointRequestEnvelope } from '../http/joint-envelope';
import {
  requireDate,
  requireNumber,
  requireOneOf,
  requireRecord,
  requireString,
  requireStringArray,
  requireStringOrNull,
} from '../http/joint-request-validation';
import { jointErrors } from '../../application/errors';
import type { ApiSuccess } from '../../../../common/contracts/api-envelope';

@UseGuards(JointAuthGuard)
@Controller('api/org/:clubId/joint')
export class OrgJointNestController {
  constructor(
    @Inject(JOINT_CONTROLLER)
    private readonly controller: JointController,
    @Inject(TRACE_CONTEXT)
    private readonly trace: TraceContextAdapter,
  ) {}

  private actor(request: Record<string, unknown>) {
    return actorFromRequest(request, this.trace.current()?.traceId ?? null);
  }

  @Post('activities')
  async initiateActivity(
    @Param('clubId') _clubId: string,
    @Req() request: Record<string, unknown>,
    @Body() body: unknown,
  ): Promise<ApiSuccess<unknown>> {
    const input = requireRecord(parseJointRequestEnvelope(body).input, 'input');
    const title = requireString(input.title, 'title');
    const confirmDeadline = requireDate(input.confirmDeadline, 'confirmDeadline');
    const clubIds = requireStringArray(input.clubIds, 'clubIds');
    const description = requireStringOrNull(input.description, 'description');
    return toHttpResponse(
      await this.controller.initiateActivity(this.actor(request), {
        title,
        description,
        confirmDeadline,
        clubIds,
        actingClubId: _clubId,
      }),
    );
  }

  @Post('activities/:activityId/propose')
  async proposeParticipation(
    @Param('clubId') _clubId: string,
    @Param('activityId') activityId: string,
    @Req() request: Record<string, unknown>,
    @Body() body: unknown,
  ): Promise<ApiSuccess<unknown>> {
    const input = requireRecord(parseJointRequestEnvelope(body).input, 'input');
    const clubId = requireString(input.clubId, 'clubId');
    return toHttpResponse(
      await this.controller.proposeParticipation(this.actor(request), {
        activityId,
        clubId,
        actingClubId: _clubId,
      }),
    );
  }

  @Post('activities/:activityId/confirm')
  async confirmParticipation(
    @Param('clubId') _clubId: string,
    @Param('activityId') activityId: string,
    @Req() request: Record<string, unknown>,
    @Body() body: unknown,
  ): Promise<ApiSuccess<unknown>> {
    const input = requireRecord(parseJointRequestEnvelope(body).input, 'input');
    const clubId = requireString(input.clubId, 'clubId');
    return toHttpResponse(
      await this.controller.confirmParticipation(this.actor(request), {
        activityId,
        clubId,
        actingClubId: _clubId,
      }),
    );
  }

  @Post('activities/:activityId/publish')
  async publishActivity(
    @Param('clubId') _clubId: string,
    @Param('activityId') activityId: string,
    @Req() request: Record<string, unknown>,
  ): Promise<ApiSuccess<unknown>> {
    return toHttpResponse(
      await this.controller.publishActivity(this.actor(request), activityId, _clubId),
    );
  }

  @Post('activities/:activityId/cancel')
  async cancelActivity(
    @Param('clubId') _clubId: string,
    @Param('activityId') activityId: string,
    @Req() request: Record<string, unknown>,
  ): Promise<ApiSuccess<unknown>> {
    return toHttpResponse(
      await this.controller.cancelActivity(this.actor(request), activityId, _clubId),
    );
  }

  @Post('activities/:activityId/begin-end')
  async beginEndConfirm(
    @Param('clubId') _clubId: string,
    @Param('activityId') activityId: string,
    @Req() request: Record<string, unknown>,
  ): Promise<ApiSuccess<unknown>> {
    return toHttpResponse(
      await this.controller.beginEndConfirm(this.actor(request), activityId, _clubId),
    );
  }

  @Post('activities/:activityId/end')
  async endActivity(
    @Param('clubId') _clubId: string,
    @Param('activityId') activityId: string,
    @Req() request: Record<string, unknown>,
  ): Promise<ApiSuccess<unknown>> {
    return toHttpResponse(
      await this.controller.endActivity(this.actor(request), activityId, _clubId),
    );
  }

  @Post('activities/:activityId/force-end')
  async forceEndActivity(
    @Param('clubId') _clubId: string,
    @Param('activityId') activityId: string,
    @Req() request: Record<string, unknown>,
    @Body() body: unknown,
  ): Promise<ApiSuccess<unknown>> {
    const input = requireRecord(parseJointRequestEnvelope(body).input, 'input');
    const reason = requireString(input.reason, 'reason');
    return toHttpResponse(
      await this.controller.forceEndActivity(this.actor(request), {
        activityId,
        reason,
        actingClubId: _clubId,
      }),
    );
  }

  @Post('activities/:activityId/participants/:participantClubId/withdraw')
  async withdrawParticipation(
    @Param('clubId') _clubId: string,
    @Param('activityId') activityId: string,
    @Param('participantClubId') participantClubId: string,
    @Req() request: Record<string, unknown>,
  ): Promise<ApiSuccess<unknown>> {
    return toHttpResponse(
      await this.controller.withdrawParticipation(this.actor(request), {
        activityId,
        clubId: participantClubId,
        actingClubId: _clubId,
      }),
    );
  }

  @Post('activities/:activityId/participants/:participantClubId/suspend')
  async suspendParticipation(
    @Param('clubId') _clubId: string,
    @Param('activityId') activityId: string,
    @Param('participantClubId') participantClubId: string,
    @Req() request: Record<string, unknown>,
  ): Promise<ApiSuccess<unknown>> {
    return toHttpResponse(
      await this.controller.suspendParticipation(this.actor(request), {
        activityId,
        clubId: participantClubId,
        actingClubId: _clubId,
      }),
    );
  }

  @Post('activities/:activityId/participants/:participantClubId/resume')
  async resumeParticipation(
    @Param('clubId') _clubId: string,
    @Param('activityId') activityId: string,
    @Param('participantClubId') participantClubId: string,
    @Req() request: Record<string, unknown>,
    @Body() body: unknown,
  ): Promise<ApiSuccess<unknown>> {
    const input = requireRecord(parseJointRequestEnvelope(body).input, 'input');
    const suspendedForMs = requireNumber(input.suspendedForMs, 'suspendedForMs');
    return toHttpResponse(
      await this.controller.resumeParticipation(this.actor(request), {
        activityId,
        clubId: participantClubId,
        actingClubId: _clubId,
        suspendedForMs,
      }),
    );
  }

  @Post('activities/:activityId/channels/open')
  async openChannel(
    @Param('clubId') _clubId: string,
    @Param('activityId') activityId: string,
    @Req() request: Record<string, unknown>,
    @Body() body: unknown,
  ): Promise<ApiSuccess<unknown>> {
    const input = requireRecord(parseJointRequestEnvelope(body).input, 'input');
    const deadline = requireDate(input.deadline, 'deadline');
    const windowId = requireStringOrNull(input.windowId, 'windowId') ?? undefined;
    return toHttpResponse(
      await this.controller.openChannel(this.actor(request), {
        jointActivityId: activityId,
        deadline,
        windowId,
        actingClubId: _clubId,
      }),
    );
  }

  @Post('activities/:activityId/channels/suspend')
  async suspendChannel(
    @Param('clubId') _clubId: string,
    @Param('activityId') activityId: string,
    @Req() request: Record<string, unknown>,
  ): Promise<ApiSuccess<unknown>> {
    return toHttpResponse(
      await this.controller.suspendChannel(this.actor(request), activityId, _clubId),
    );
  }

  @Post('activities/:activityId/channels/resume')
  async resumeChannel(
    @Param('clubId') _clubId: string,
    @Param('activityId') activityId: string,
    @Req() request: Record<string, unknown>,
    @Body() body: unknown,
  ): Promise<ApiSuccess<unknown>> {
    const input = requireRecord(parseJointRequestEnvelope(body).input, 'input');
    const deadline = requireDate(input.deadline, 'deadline');
    const windowId = requireStringOrNull(input.windowId, 'windowId') ?? undefined;
    return toHttpResponse(
      await this.controller.resumeChannel(this.actor(request), {
        jointActivityId: activityId,
        deadline,
        windowId,
        actingClubId: _clubId,
      }),
    );
  }

  @Post('activities/:activityId/channels/extend')
  async extendChannel(
    @Param('clubId') _clubId: string,
    @Param('activityId') activityId: string,
    @Req() request: Record<string, unknown>,
    @Body() body: unknown,
  ): Promise<ApiSuccess<unknown>> {
    const input = requireRecord(parseJointRequestEnvelope(body).input, 'input');
    const deadline = requireDate(input.deadline, 'deadline');
    return toHttpResponse(
      await this.controller.extendChannel(this.actor(request), {
        jointActivityId: activityId,
        deadline,
        actingClubId: _clubId,
      }),
    );
  }

  @Post('activities/:activityId/channels/close')
  async closeChannel(
    @Param('clubId') _clubId: string,
    @Param('activityId') activityId: string,
    @Req() request: Record<string, unknown>,
  ): Promise<ApiSuccess<unknown>> {
    return toHttpResponse(
      await this.controller.closeChannel(this.actor(request), activityId, _clubId),
    );
  }

  @Post('activities/:activityId/channels/reopen')
  async reopenChannel(
    @Param('clubId') _clubId: string,
    @Param('activityId') activityId: string,
    @Req() request: Record<string, unknown>,
    @Body() body: unknown,
  ): Promise<ApiSuccess<unknown>> {
    const input = requireRecord(parseJointRequestEnvelope(body).input, 'input');
    const deadline = requireDate(input.deadline, 'deadline');
    const windowId = requireStringOrNull(input.windowId, 'windowId') ?? undefined;
    return toHttpResponse(
      await this.controller.reopenChannel(this.actor(request), {
        jointActivityId: activityId,
        deadline,
        windowId,
        actingClubId: _clubId,
      }),
    );
  }

  @Post('applications/:applicationId/interviews/schedule')
  async scheduleInterview(
    @Param('clubId') _clubId: string,
    @Param('applicationId') applicationId: string,
    @Req() request: Record<string, unknown>,
    @Body() body: unknown,
  ): Promise<ApiSuccess<unknown>> {
    const input = requireRecord(parseJointRequestEnvelope(body).input, 'input');
    const jointActivityId = requireString(input.jointActivityId, 'jointActivityId');
    const jointApplicationId = requireString(input.jointApplicationId, 'jointApplicationId');
    if (jointApplicationId !== applicationId) {
      throw jointErrors.validation(
        '路径 applicationId 与请求体 jointApplicationId 不一致，请检查后重试',
      );
    }
    const scheduledAt = requireDate(input.scheduledAt, 'scheduledAt');
    const location = requireString(input.location, 'location');
    const method = requireString(input.method, 'method');
    const id = requireStringOrNull(input.id, 'id');
    return toHttpResponse(
      await this.controller.scheduleInterview(this.actor(request), {
        jointActivityId,
        jointApplicationId,
        scheduledAt,
        location,
        method,
        actingClubId: _clubId,
        id: id ?? undefined,
      }),
    );
  }

  @Post('interviews/:interviewId/start')
  async startInterview(
    @Param('clubId') _clubId: string,
    @Param('interviewId') interviewId: string,
    @Req() request: Record<string, unknown>,
  ): Promise<ApiSuccess<unknown>> {
    return toHttpResponse(
      await this.controller.startInterview(this.actor(request), interviewId, _clubId),
    );
  }

  @Post('interviews/:interviewId/complete')
  async completeInterview(
    @Param('clubId') _clubId: string,
    @Param('interviewId') interviewId: string,
    @Req() request: Record<string, unknown>,
  ): Promise<ApiSuccess<unknown>> {
    return toHttpResponse(
      await this.controller.completeInterview(this.actor(request), interviewId, _clubId),
    );
  }

  @Post('interviews/:interviewId/void')
  async voidInterview(
    @Param('clubId') _clubId: string,
    @Param('interviewId') interviewId: string,
    @Req() request: Record<string, unknown>,
    @Body() body: unknown,
  ): Promise<ApiSuccess<unknown>> {
    const input = requireRecord(parseJointRequestEnvelope(body).input, 'input');
    const reason = requireString(input.reason, 'reason');
    return toHttpResponse(
      await this.controller.voidInterview(this.actor(request), {
        interviewId,
        reason,
        actingClubId: _clubId,
      }),
    );
  }

  @Post('interviews/:interviewId/evaluations')
  async recordEvaluation(
    @Param('clubId') _clubId: string,
    @Param('interviewId') interviewId: string,
    @Req() request: Record<string, unknown>,
    @Body() body: unknown,
  ): Promise<ApiSuccess<unknown>> {
    const input = requireRecord(parseJointRequestEnvelope(body).input, 'input');
    const clubId = requireString(input.clubId, 'clubId');
    const values = requireRecord(input.values, 'values');
    return toHttpResponse(
      await this.controller.recordEvaluation(this.actor(request), {
        interviewId,
        clubId,
        actingClubId: _clubId,
        values,
      }),
    );
  }

  @Post('applications/:applicationId/conclusions')
  async editConclusion(
    @Param('clubId') _clubId: string,
    @Param('applicationId') applicationId: string,
    @Req() request: Record<string, unknown>,
    @Body() body: unknown,
  ): Promise<ApiSuccess<unknown>> {
    const input = requireRecord(parseJointRequestEnvelope(body).input, 'input');
    const jointActivityId = requireString(input.jointActivityId, 'jointActivityId');
    const jointApplicationId = requireString(input.jointApplicationId, 'jointApplicationId');
    const clubId = requireString(input.clubId, 'clubId');
    const decision = requireOneOf(input.decision, 'decision', ['ADMIT', 'TRANSFER', 'REJECT']);
    const note = requireStringOrNull(input.note, 'note');
    return toHttpResponse(
      await this.controller.editConclusion(this.actor(request), {
        jointActivityId,
        jointApplicationId,
        clubId,
        actingClubId: _clubId,
        decision,
        note,
      }),
    );
  }

  @Post('conclusions/:conclusionId/invite')
  async sendInvitation(
    @Param('clubId') _clubId: string,
    @Param('conclusionId') conclusionId: string,
    @Req() request: Record<string, unknown>,
  ): Promise<ApiSuccess<unknown>> {
    return toHttpResponse(
      await this.controller.sendInvitation(this.actor(request), conclusionId, _clubId),
    );
  }

  @Post('conclusions/:conclusionId/restore')
  async restoreFromReview(
    @Param('clubId') _clubId: string,
    @Param('conclusionId') conclusionId: string,
    @Req() request: Record<string, unknown>,
  ): Promise<ApiSuccess<unknown>> {
    return toHttpResponse(
      await this.controller.restoreFromReview(this.actor(request), conclusionId, _clubId),
    );
  }

  @Get('activities/:activityId')
  async getActivity(
    @Param('clubId') clubId: string,
    @Param('activityId') activityId: string,
    @Req() request: Record<string, unknown>,
  ): Promise<ApiSuccess<unknown>> {
    return toHttpResponse(
      await this.controller.getActivity(this.actor(request), activityId, clubId),
    );
  }

  @Get('activities/:activityId/participants')
  async listParticipants(
    @Param('clubId') clubId: string,
    @Param('activityId') activityId: string,
    @Req() request: Record<string, unknown>,
  ): Promise<ApiSuccess<unknown>> {
    return toHttpResponse(
      await this.controller.listParticipants(this.actor(request), activityId, clubId),
    );
  }

  @Get('activities/:activityId/applications')
  async listApplications(
    @Param('clubId') clubId: string,
    @Param('activityId') activityId: string,
    @Req() request: Record<string, unknown>,
  ): Promise<ApiSuccess<unknown>> {
    return toHttpResponse(
      await this.controller.listApplications(this.actor(request), activityId, clubId),
    );
  }

  @Get('activities/:activityId/channel')
  async getChannel(
    @Param('clubId') _clubId: string,
    @Param('activityId') activityId: string,
    @Req() request: Record<string, unknown>,
  ): Promise<ApiSuccess<unknown>> {
    return toHttpResponse(
      await this.controller.getChannel(this.actor(request), activityId, _clubId),
    );
  }
}
