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
 * - POST /api/org/:clubId/joint/activities/:activityId/participants/:clubId/withdraw
 * - POST /api/org/:clubId/joint/activities/:activityId/participants/:clubId/suspend
 * - POST /api/org/:clubId/joint/activities/:activityId/participants/:clubId/resume
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
    const input = parseJointRequestEnvelope(body).input as {
      title: string;
      description?: string | null;
      confirmDeadline: string;
      clubIds: string[];
    };
    return toHttpResponse(
      await this.controller.initiateActivity(this.actor(request), {
        title: input.title,
        description: input.description ?? null,
        confirmDeadline: new Date(input.confirmDeadline),
        clubIds: input.clubIds,
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
    const input = parseJointRequestEnvelope(body).input as { clubId: string };
    return toHttpResponse(
      await this.controller.proposeParticipation(this.actor(request), {
        activityId,
        clubId: input.clubId,
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
    const input = parseJointRequestEnvelope(body).input as { clubId: string };
    return toHttpResponse(
      await this.controller.confirmParticipation(this.actor(request), {
        activityId,
        clubId: input.clubId,
      }),
    );
  }

  @Post('activities/:activityId/publish')
  async publishActivity(
    @Param('clubId') _clubId: string,
    @Param('activityId') activityId: string,
    @Req() request: Record<string, unknown>,
  ): Promise<ApiSuccess<unknown>> {
    return toHttpResponse(await this.controller.publishActivity(this.actor(request), activityId));
  }

  @Post('activities/:activityId/cancel')
  async cancelActivity(
    @Param('clubId') _clubId: string,
    @Param('activityId') activityId: string,
    @Req() request: Record<string, unknown>,
  ): Promise<ApiSuccess<unknown>> {
    return toHttpResponse(await this.controller.cancelActivity(this.actor(request), activityId));
  }

  @Post('activities/:activityId/begin-end')
  async beginEndConfirm(
    @Param('clubId') _clubId: string,
    @Param('activityId') activityId: string,
    @Req() request: Record<string, unknown>,
  ): Promise<ApiSuccess<unknown>> {
    return toHttpResponse(await this.controller.beginEndConfirm(this.actor(request), activityId));
  }

  @Post('activities/:activityId/end')
  async endActivity(
    @Param('clubId') _clubId: string,
    @Param('activityId') activityId: string,
    @Req() request: Record<string, unknown>,
  ): Promise<ApiSuccess<unknown>> {
    return toHttpResponse(await this.controller.endActivity(this.actor(request), activityId));
  }

  @Post('activities/:activityId/force-end')
  async forceEndActivity(
    @Param('clubId') _clubId: string,
    @Param('activityId') activityId: string,
    @Req() request: Record<string, unknown>,
    @Body() body: unknown,
  ): Promise<ApiSuccess<unknown>> {
    const input = parseJointRequestEnvelope(body).input as { reason: string };
    return toHttpResponse(
      await this.controller.forceEndActivity(this.actor(request), {
        activityId,
        reason: input.reason,
      }),
    );
  }

  @Post('activities/:activityId/participants/:clubId/withdraw')
  async withdrawParticipation(
    @Param('clubId') _clubId: string,
    @Param('activityId') activityId: string,
    @Param('clubId') participantClubId: string,
    @Req() request: Record<string, unknown>,
  ): Promise<ApiSuccess<unknown>> {
    return toHttpResponse(
      await this.controller.withdrawParticipation(this.actor(request), {
        activityId,
        clubId: participantClubId,
      }),
    );
  }

  @Post('activities/:activityId/participants/:clubId/suspend')
  async suspendParticipation(
    @Param('clubId') _clubId: string,
    @Param('activityId') activityId: string,
    @Param('clubId') participantClubId: string,
    @Req() request: Record<string, unknown>,
  ): Promise<ApiSuccess<unknown>> {
    return toHttpResponse(
      await this.controller.suspendParticipation(this.actor(request), {
        activityId,
        clubId: participantClubId,
      }),
    );
  }

  @Post('activities/:activityId/participants/:clubId/resume')
  async resumeParticipation(
    @Param('clubId') _clubId: string,
    @Param('activityId') activityId: string,
    @Param('clubId') participantClubId: string,
    @Req() request: Record<string, unknown>,
    @Body() body: unknown,
  ): Promise<ApiSuccess<unknown>> {
    const input = parseJointRequestEnvelope(body).input as { suspendedForMs: number };
    return toHttpResponse(
      await this.controller.resumeParticipation(this.actor(request), {
        activityId,
        clubId: participantClubId,
        suspendedForMs: input.suspendedForMs,
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
    const input = parseJointRequestEnvelope(body).input as { deadline: string; windowId?: string };
    return toHttpResponse(
      await this.controller.openChannel(this.actor(request), {
        jointActivityId: activityId,
        deadline: new Date(input.deadline),
        windowId: input.windowId,
      }),
    );
  }

  @Post('activities/:activityId/channels/suspend')
  async suspendChannel(
    @Param('clubId') _clubId: string,
    @Param('activityId') activityId: string,
    @Req() request: Record<string, unknown>,
  ): Promise<ApiSuccess<unknown>> {
    return toHttpResponse(await this.controller.suspendChannel(this.actor(request), activityId));
  }

  @Post('activities/:activityId/channels/resume')
  async resumeChannel(
    @Param('clubId') _clubId: string,
    @Param('activityId') activityId: string,
    @Req() request: Record<string, unknown>,
    @Body() body: unknown,
  ): Promise<ApiSuccess<unknown>> {
    const input = parseJointRequestEnvelope(body).input as { deadline: string; windowId?: string };
    return toHttpResponse(
      await this.controller.resumeChannel(this.actor(request), {
        jointActivityId: activityId,
        deadline: new Date(input.deadline),
        windowId: input.windowId,
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
    const input = parseJointRequestEnvelope(body).input as { deadline: string };
    return toHttpResponse(
      await this.controller.extendChannel(this.actor(request), {
        jointActivityId: activityId,
        deadline: new Date(input.deadline),
      }),
    );
  }

  @Post('activities/:activityId/channels/close')
  async closeChannel(
    @Param('clubId') _clubId: string,
    @Param('activityId') activityId: string,
    @Req() request: Record<string, unknown>,
  ): Promise<ApiSuccess<unknown>> {
    return toHttpResponse(await this.controller.closeChannel(this.actor(request), activityId));
  }

  @Post('activities/:activityId/channels/reopen')
  async reopenChannel(
    @Param('clubId') _clubId: string,
    @Param('activityId') activityId: string,
    @Req() request: Record<string, unknown>,
    @Body() body: unknown,
  ): Promise<ApiSuccess<unknown>> {
    const input = parseJointRequestEnvelope(body).input as { deadline: string; windowId?: string };
    return toHttpResponse(
      await this.controller.reopenChannel(this.actor(request), {
        jointActivityId: activityId,
        deadline: new Date(input.deadline),
        windowId: input.windowId,
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
    const input = parseJointRequestEnvelope(body).input as {
      jointActivityId: string;
      jointApplicationId: string;
      scheduledAt: string;
      location: string;
      method: string;
      id?: string;
    };
    return toHttpResponse(
      await this.controller.scheduleInterview(this.actor(request), {
        jointActivityId: input.jointActivityId,
        jointApplicationId: input.jointApplicationId,
        scheduledAt: new Date(input.scheduledAt),
        location: input.location,
        method: input.method,
        id: input.id,
      }),
    );
  }

  @Post('interviews/:interviewId/start')
  async startInterview(
    @Param('clubId') _clubId: string,
    @Param('interviewId') interviewId: string,
    @Req() request: Record<string, unknown>,
  ): Promise<ApiSuccess<unknown>> {
    return toHttpResponse(await this.controller.startInterview(this.actor(request), interviewId));
  }

  @Post('interviews/:interviewId/complete')
  async completeInterview(
    @Param('clubId') _clubId: string,
    @Param('interviewId') interviewId: string,
    @Req() request: Record<string, unknown>,
  ): Promise<ApiSuccess<unknown>> {
    return toHttpResponse(
      await this.controller.completeInterview(this.actor(request), interviewId),
    );
  }

  @Post('interviews/:interviewId/void')
  async voidInterview(
    @Param('clubId') _clubId: string,
    @Param('interviewId') interviewId: string,
    @Req() request: Record<string, unknown>,
    @Body() body: unknown,
  ): Promise<ApiSuccess<unknown>> {
    const input = parseJointRequestEnvelope(body).input as { reason: string };
    return toHttpResponse(
      await this.controller.voidInterview(this.actor(request), {
        interviewId,
        reason: input.reason,
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
    const input = parseJointRequestEnvelope(body).input as {
      clubId: string;
      interviewerId: string;
      values: Record<string, unknown>;
    };
    return toHttpResponse(
      await this.controller.recordEvaluation(this.actor(request), {
        interviewId,
        clubId: input.clubId,
        interviewerId: input.interviewerId,
        values: input.values,
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
    const input = parseJointRequestEnvelope(body).input as {
      jointActivityId: string;
      jointApplicationId: string;
      clubId: string;
      decision: 'ADMIT' | 'TRANSFER' | 'REJECT';
      note?: string | null;
    };
    return toHttpResponse(
      await this.controller.editConclusion(this.actor(request), {
        jointActivityId: input.jointActivityId,
        jointApplicationId: input.jointApplicationId,
        clubId: input.clubId,
        decision: input.decision,
        note: input.note ?? null,
      }),
    );
  }

  @Post('conclusions/:conclusionId/invite')
  async sendInvitation(
    @Param('clubId') _clubId: string,
    @Param('conclusionId') conclusionId: string,
    @Req() request: Record<string, unknown>,
  ): Promise<ApiSuccess<unknown>> {
    return toHttpResponse(await this.controller.sendInvitation(this.actor(request), conclusionId));
  }

  @Post('conclusions/:conclusionId/restore')
  async restoreFromReview(
    @Param('clubId') _clubId: string,
    @Param('conclusionId') conclusionId: string,
    @Req() request: Record<string, unknown>,
  ): Promise<ApiSuccess<unknown>> {
    return toHttpResponse(
      await this.controller.restoreFromReview(this.actor(request), conclusionId),
    );
  }

  @Get('activities/:activityId')
  async getActivity(
    @Param('clubId') _clubId: string,
    @Param('activityId') activityId: string,
    @Req() request: Record<string, unknown>,
  ): Promise<ApiSuccess<unknown>> {
    return toHttpResponse(await this.controller.getActivity(this.actor(request), activityId));
  }

  @Get('activities/:activityId/participants')
  async listParticipants(
    @Param('clubId') _clubId: string,
    @Param('activityId') activityId: string,
    @Req() request: Record<string, unknown>,
  ): Promise<ApiSuccess<unknown>> {
    return toHttpResponse(await this.controller.listParticipants(this.actor(request), activityId));
  }

  @Get('activities/:activityId/applications')
  async listApplications(
    @Param('clubId') _clubId: string,
    @Param('activityId') activityId: string,
    @Req() request: Record<string, unknown>,
  ): Promise<ApiSuccess<unknown>> {
    return toHttpResponse(await this.controller.listApplications(this.actor(request), activityId));
  }

  @Get('activities/:activityId/channel')
  async getChannel(
    @Param('clubId') _clubId: string,
    @Param('activityId') activityId: string,
    @Req() request: Record<string, unknown>,
  ): Promise<ApiSuccess<unknown>> {
    return toHttpResponse(await this.controller.getChannel(this.actor(request), activityId));
  }
}
