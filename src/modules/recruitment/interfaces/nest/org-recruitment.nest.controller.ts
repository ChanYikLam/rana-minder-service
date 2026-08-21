/**
 * 组织招新端点 Nest 适配控制器（interfaces/nest；4.4，含 REC-005 面试）。
 *
 * 路由（作用域由路径 clubId 冻结）：
 * - POST /api/org/:clubId/recruitment/activities                      创建招新活动
 * - POST /api/org/:clubId/recruitment/activities/:activityId/publish  发布招新活动
 * - POST /api/org/:clubId/recruitment/activities/:activityId/channels 开放报名通道
 * - POST /api/org/:clubId/recruitment/applications                    提交招新申请
 * - POST /api/org/:clubId/recruitment/applications/:applicationId/decisions  记录部门决定
 * - POST /api/org/:clubId/recruitment/applications/:applicationId/interviews     调度面试
 * - POST /api/org/:clubId/recruitment/interviews/:interviewId/start|complete|void|cancel|resume
 * - POST /api/org/:clubId/recruitment/interviews/:interviewId/skip   { reason }
 * - POST /api/org/:clubId/recruitment/interviews/:interviewId/hold   { until }
 * - POST /api/org/:clubId/recruitment/interviews/:interviewId/evaluations  { values }
 * - GET  /api/org/:clubId/recruitment/activities                     列出活动
 * - GET  /api/org/:clubId/recruitment/activities/:activityId/applications  列出申请
 * - GET  /api/org/:clubId/recruitment/rounds/:roundId/interviews     按轮次列面试
 */

import { Body, Controller, Get, Inject, Param, Post, Req, UseGuards } from '@nestjs/common';

import { TRACE_CONTEXT } from '../../../../platform/observability/tracing/tokens';
import type { TraceContextAdapter } from '../../../../platform/observability/infrastructure/trace-context.adapter';
import { RECRUITMENT_CONTROLLER } from '../../tokens';
import type { RecruitmentController } from '../controllers/recruitment.controller';
import { RecruitmentAuthGuard } from './recruitment-auth.guard';
import { toHttpResponse, actorFromRequest } from './recruitment-response-mapper';
import { parseRecruitmentRequestEnvelope } from '../http/recruitment-envelope';
import type { DepartmentDecision } from '../../domain/state-machines/department-path.state-machine';
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
      endDate?: string;
    };
    return toHttpResponse(
      await this.controller.createActivity(this.actor(request), clubId, {
        title: input.title,
        description: input.description ?? null,
        endDate: input.endDate ? new Date(input.endDate) : null,
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
      await this.controller.publishActivity(this.actor(request), activityId),
    );
  }

  @Post('activities/:activityId/channels')
  async openChannel(
    @Param('clubId') _clubId: string,
    @Param('activityId') activityId: string,
    @Req() request: Record<string, unknown>,
    @Body() body: unknown,
  ): Promise<ApiSuccess<unknown>> {
    const input = parseRecruitmentRequestEnvelope(body).input as {
      minChoices?: number;
      maxChoices?: number;
    };
    return toHttpResponse(
      await this.controller.openChannel(this.actor(request), activityId, {
        minChoices: input.minChoices,
        maxChoices: input.maxChoices,
      }),
    );
  }

  @Post('applications')
  async submitApplication(
    @Param('clubId') _clubId: string,
    @Req() request: Record<string, unknown>,
    @Body() body: unknown,
  ): Promise<ApiSuccess<unknown>> {
    const env = parseRecruitmentRequestEnvelope(body);
    const input = env.input as {
      activityId: string;
      channelId: string;
      departmentChoices: string[];
      formRef?: { formId: string; submissionId: string; versionNumber: number } | null;
      qualifySnapshot?: Record<string, unknown> | null;
    };
    return toHttpResponse(
      await this.controller.submitApplication(this.actor(request), {
        activityId: input.activityId,
        applicantId: this.actor(request).subjectId,
        channelId: input.channelId,
        departmentChoices: input.departmentChoices,
        formRef: input.formRef ?? null,
        qualifySnapshot: input.qualifySnapshot ?? null,
      }),
    );
  }

  @Post('applications/:applicationId/decisions')
  async recordDecision(
    @Param('clubId') _clubId: string,
    @Param('applicationId') applicationId: string,
    @Req() request: Record<string, unknown>,
    @Body() body: unknown,
  ): Promise<ApiSuccess<unknown>> {
    const input = parseRecruitmentRequestEnvelope(body).input as {
      departmentId: string;
      decision: string;
      note?: string | null;
    };
    return toHttpResponse(
      await this.controller.recordDecision(this.actor(request), applicationId, {
        departmentId: input.departmentId,
        decision: input.decision as DepartmentDecision,
        decidedBy: this.actor(request).subjectId,
        note: input.note ?? null,
      }),
    );
  }

  @Post('applications/:applicationId/interviews')
  async scheduleInterview(
    @Param('clubId') _clubId: string,
    @Param('applicationId') applicationId: string,
    @Req() request: Record<string, unknown>,
    @Body() body: unknown,
  ): Promise<ApiSuccess<unknown>> {
    const input = parseRecruitmentRequestEnvelope(body).input as {
      roundId: string;
      interviewerId: string;
      scheduledAt: string;
      location?: string | null;
    };
    return toHttpResponse(
      await this.controller.scheduleInterview(this.actor(request), {
        applicationId,
        roundId: input.roundId,
        interviewerId: input.interviewerId,
        scheduledAt: new Date(input.scheduledAt),
        location: input.location ?? null,
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
  ): Promise<ApiSuccess<unknown>> {
    return toHttpResponse(await this.controller.voidInterview(this.actor(request), interviewId));
  }

  @Post('interviews/:interviewId/cancel')
  async cancelInterview(
    @Param('clubId') _clubId: string,
    @Param('interviewId') interviewId: string,
    @Req() request: Record<string, unknown>,
  ): Promise<ApiSuccess<unknown>> {
    return toHttpResponse(await this.controller.cancelInterview(this.actor(request), interviewId));
  }

  @Post('interviews/:interviewId/skip')
  async skipInterview(
    @Param('clubId') _clubId: string,
    @Param('interviewId') interviewId: string,
    @Req() request: Record<string, unknown>,
    @Body() body: unknown,
  ): Promise<ApiSuccess<unknown>> {
    const input = parseRecruitmentRequestEnvelope(body).input as { reason: string };
    return toHttpResponse(
      await this.controller.skipInterview(this.actor(request), {
        interviewId,
        reason: input.reason,
      }),
    );
  }

  @Post('interviews/:interviewId/hold')
  async holdInterview(
    @Param('clubId') _clubId: string,
    @Param('interviewId') interviewId: string,
    @Req() request: Record<string, unknown>,
    @Body() body: unknown,
  ): Promise<ApiSuccess<unknown>> {
    const input = parseRecruitmentRequestEnvelope(body).input as { until: string };
    return toHttpResponse(
      await this.controller.holdInterview(this.actor(request), {
        interviewId,
        until: new Date(input.until),
      }),
    );
  }

  @Post('interviews/:interviewId/resume')
  async resumeInterview(
    @Param('clubId') _clubId: string,
    @Param('interviewId') interviewId: string,
    @Req() request: Record<string, unknown>,
  ): Promise<ApiSuccess<unknown>> {
    return toHttpResponse(await this.controller.resumeInterview(this.actor(request), interviewId));
  }

  @Post('interviews/:interviewId/evaluations')
  async recordEvaluation(
    @Param('clubId') _clubId: string,
    @Param('interviewId') interviewId: string,
    @Req() request: Record<string, unknown>,
    @Body() body: unknown,
  ): Promise<ApiSuccess<unknown>> {
    const input = parseRecruitmentRequestEnvelope(body).input as {
      values: Record<string, unknown>;
    };
    return toHttpResponse(
      await this.controller.recordInterviewEvaluation(this.actor(request), {
        interviewId,
        values: input.values,
      }),
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

  @Post('applications/:applicationId/invitations')
  async sendInvitation(
    @Param('clubId') _clubId: string,
    @Param('applicationId') applicationId: string,
    @Req() request: Record<string, unknown>,
    @Body() body: unknown,
  ): Promise<ApiSuccess<unknown>> {
    const env = parseRecruitmentRequestEnvelope(body);
    return toHttpResponse(
      await this.controller.sendInvitation(this.actor(request), applicationId, env.expectedVersion),
    );
  }

  @Post('applications/:applicationId/accept')
  async acceptInvitation(
    @Param('clubId') _clubId: string,
    @Param('applicationId') applicationId: string,
    @Req() request: Record<string, unknown>,
    @Body() body: unknown,
  ): Promise<ApiSuccess<unknown>> {
    const env = parseRecruitmentRequestEnvelope(body);
    return toHttpResponse(
      await this.controller.acceptInvitation(
        this.actor(request),
        applicationId,
        env.expectedVersion,
      ),
    );
  }

  @Get('rounds/:roundId/interviews')
  async listInterviews(
    @Param('clubId') _clubId: string,
    @Param('roundId') roundId: string,
    @Req() request: Record<string, unknown>,
  ): Promise<ApiSuccess<unknown>> {
    return toHttpResponse(await this.controller.listInterviews(this.actor(request), roundId));
  }
}
