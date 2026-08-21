/**
 * 组织招新端点 Nest 适配控制器（interfaces/nest；4.4）。
 *
 * 路由（作用域由路径 clubId 冻结）：
 * - POST /api/org/:clubId/recruitment/activities            创建招新活动
 * - POST /api/org/:clubId/recruitment/activities/:activityId/channels  开放报名通道
 * - POST /api/org/:clubId/recruitment/applications         提交招新申请
 * - POST /api/org/:clubId/recruitment/applications/:applicationId/decisions  记录部门决定
 * - GET  /api/org/:clubId/recruitment/activities           列出活动
 * - GET  /api/org/:clubId/recruitment/activities/:activityId/applications  列出申请
 */

import { Body, Controller, Get, Inject, Param, Post, Req, UseGuards } from '@nestjs/common';

import { TRACE_CONTEXT } from '../../../../platform/observability/tracing/tokens';
import type { TraceContextAdapter } from '../../../../platform/observability/infrastructure/trace-context.adapter';
import { RECRUITMENT_CONTROLLER } from '../../tokens';
import type { RecruitmentController } from '../controllers/recruitment.controller';
import { RecruitmentAuthGuard } from './recruitment-auth.guard';
import { toHttpResponse, actorFromRequest } from './recruitment-response-mapper';
import { parseRecruitmentRequestEnvelope } from '../http/recruitment-envelope';
import type { ApiSuccess } from '../../../../common/contracts/api-envelope';

@UseGuards(RecruitmentAuthGuard)
@Controller('api/org/:clubId/recruitment')
export class OrgRecruitmentNestController {
  constructor(
    @Inject(RECRUITMENT_CONTROLLER)
    private readonly controller: RecruitmentController,
    @Inject(TRACE_CONTEXT)
    private readonly trace: TraceContextAdapter,
  ) {}

  private actor(request: Record<string, unknown>) {
    return actorFromRequest(request, this.trace.current()?.traceId ?? null);
  }

  @Post('activities')
  async createActivity(
    @Param('clubId') clubId: string,
    @Req() request: Record<string, unknown>,
    @Body() body: unknown,
  ): Promise<ApiSuccess<unknown>> {
    const input = parseRecruitmentRequestEnvelope(body).input as {
      title: string;
      description?: string | null;
    };
    return toHttpResponse(
      await this.controller.createActivity(this.actor(request), clubId, {
        title: input.title,
        description: input.description ?? null,
      }),
    );
  }

  @Post('activities/:activityId/channels')
  async openChannel(
    @Param('clubId') _clubId: string,
    @Param('activityId') activityId: string,
    @Req() request: Record<string, unknown>,
  ): Promise<ApiSuccess<unknown>> {
    return toHttpResponse(await this.controller.openChannel(this.actor(request), activityId));
  }

  @Post('applications')
  async submitApplication(
    @Param('clubId') _clubId: string,
    @Req() request: Record<string, unknown>,
    @Body() body: unknown,
  ): Promise<ApiSuccess<unknown>> {
    const input = parseRecruitmentRequestEnvelope(body).input as Record<string, unknown>;
    return toHttpResponse(await this.controller.submitApplication(this.actor(request), input as never));
  }

  @Post('applications/:applicationId/decisions')
  async recordDecision(
    @Param('clubId') _clubId: string,
    @Param('applicationId') applicationId: string,
    @Req() request: Record<string, unknown>,
    @Body() body: unknown,
  ): Promise<ApiSuccess<unknown>> {
    const input = parseRecruitmentRequestEnvelope(body).input as Record<string, unknown>;
    return toHttpResponse(
      await this.controller.recordDecision(this.actor(request), applicationId, input as never),
    );
  }

  @Get('activities')
  async listActivities(
    @Param('clubId') clubId: string,
    @Req() request: Record<string, unknown>,
  ): Promise<ApiSuccess<unknown>> {
    return toHttpResponse(await this.controller.listActivities(this.actor(request), clubId));
  }

  @Get('activities/:activityId/applications')
  async listApplications(
    @Param('clubId') _clubId: string,
    @Param('activityId') activityId: string,
    @Req() request: Record<string, unknown>,
  ): Promise<ApiSuccess<unknown>> {
    return toHttpResponse(await this.controller.listApplications(this.actor(request), activityId));
  }
}
