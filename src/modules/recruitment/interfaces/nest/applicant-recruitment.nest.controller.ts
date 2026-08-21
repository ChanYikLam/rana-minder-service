/**
 * 申请人自助招新端点 Nest 适配控制器（interfaces/nest；4.4）。
 *
 * 与组织管理命名空间（api/org/:clubId/recruitment）分离，面向申请人本人：
 * - POST /api/recruitment/applications/:applicationId/accept  接受录取（subjectId 取自身份会话）
 *
 * 作用域不绑定 clubId 路径参数；鉴权由 RecruitmentAuthGuard 保证已认证，
 * AcceptAdmissionInvitationUseCase 内部校验 actor 为申请人本人或负责人/人事。
 */

import { Body, Controller, Inject, Param, Post, Req, UseGuards } from '@nestjs/common';

import { TRACE_CONTEXT } from '../../../../platform/observability/tracing/tokens';
import type { TraceContextAdapter } from '../../../../platform/observability/infrastructure/trace-context.adapter';
import { RECRUITMENT_CONTROLLER } from '../../tokens';
import type { RecruitmentController } from '../controllers/recruitment.controller';
import { RecruitmentAuthGuard } from './recruitment-auth.guard';
import { toHttpResponse, actorFromRequest } from './recruitment-response-mapper';
import { parseRecruitmentRequestEnvelope } from '../http/recruitment-envelope';
import type { ApiSuccess } from '../../../../common/contracts/api-envelope';

@UseGuards(RecruitmentAuthGuard)
@Controller('api/recruitment')
export class ApplicantRecruitmentNestController {
  constructor(
    @Inject(RECRUITMENT_CONTROLLER)
    private readonly controller: RecruitmentController,
    @Inject(TRACE_CONTEXT)
    private readonly trace: TraceContextAdapter,
  ) {}

  private actor(request: Record<string, unknown>) {
    return actorFromRequest(request, this.trace.current()?.traceId ?? null);
  }

  @Post('applications/:applicationId/accept')
  async acceptInvitation(
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
}
