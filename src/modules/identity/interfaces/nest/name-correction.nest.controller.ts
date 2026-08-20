/**
 * 姓名更正端点 Nest 适配控制器（interfaces/nest；IDN-016）。
 *
 * 路由：POST /api/auth/profile/name-correction（本人提交）、
 * POST /api/auth/profile/name-correction/review（超管裁决）。
 * 全部经 AuthGuard 认证；subjectId 恒来自会话（AUT）。
 */

import { Body, Controller, Inject, Post, Req, UseGuards } from '@nestjs/common';

import { TRACE_CONTEXT } from '../../../../platform/observability/tracing/tokens';
import type { TraceContextAdapter } from '../../../../platform/observability/infrastructure/trace-context.adapter';
import { NAME_CORRECTION_CONTROLLER } from '../../tokens';
import type {
  NameCorrectionController,
  SubmitNameCorrectionResponse,
  ReviewNameCorrectionResponse,
} from '../controllers/name-correction.controller';
import { AuthGuard } from './auth.guard';
import { toHttpResponse, actorFromRequest } from './response-mapper';
import type { ApiSuccess } from '../../../../common/contracts/api-envelope';

@UseGuards(AuthGuard)
@Controller('api/auth/profile/name-correction')
export class NameCorrectionNestController {
  constructor(
    @Inject(NAME_CORRECTION_CONTROLLER)
    private readonly controller: NameCorrectionController,
    @Inject(TRACE_CONTEXT)
    private readonly trace: TraceContextAdapter,
  ) {}

  @Post()
  async submit(
    @Req() request: Record<string, unknown>,
    @Body() body: unknown,
  ): Promise<ApiSuccess<SubmitNameCorrectionResponse>> {
    return toHttpResponse(await this.controller.submit(this.actor(request), body));
  }

  @Post('review')
  async review(
    @Req() request: Record<string, unknown>,
    @Body() body: unknown,
  ): Promise<ApiSuccess<ReviewNameCorrectionResponse>> {
    return toHttpResponse(await this.controller.review(this.actor(request), body));
  }

  private actor(request: Record<string, unknown>) {
    return actorFromRequest(request, this.trace.current()?.traceId ?? null);
  }
}
