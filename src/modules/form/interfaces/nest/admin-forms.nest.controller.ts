/**
 * 平台管理端点 Nest 适配控制器（interfaces/nest；接口清单 §13 管理侧）。
 *
 * 路由：GET /api/admin/forms/template-publications、
 * POST /api/admin/forms/template-publications/:publicationId/review。
 * 权限由用例侧 canManagePlatform（超管）失败关闭守卫，未接入组织层前一律拒绝。
 */

import { Body, Controller, Get, Inject, Param, Post, Query, Req, UseGuards } from '@nestjs/common';

import { TRACE_CONTEXT } from '../../../../platform/observability/tracing/tokens';
import type { TraceContextAdapter } from '../../../../platform/observability/infrastructure/trace-context.adapter';
import { FORM_DESIGN_CONTROLLER } from '../../tokens';
import type { FormDesignController } from '../controllers/form-design.controller';
import { FormAuthGuard } from './form-auth.guard';
import { toHttpResponse, actorFromRequest } from './form-response-mapper';
import { parseFormRequestEnvelope } from '../http/form-envelope';
import type { ApiSuccess } from '../../../../common/contracts/api-envelope';
import type { TemplatePublicationState } from '../../domain/models/template-publication';

@UseGuards(FormAuthGuard)
@Controller('api/admin/forms/template-publications')
export class AdminFormsNestController {
  constructor(
    @Inject(FORM_DESIGN_CONTROLLER)
    private readonly controller: FormDesignController,
    @Inject(TRACE_CONTEXT)
    private readonly trace: TraceContextAdapter,
  ) {}

  private actor(request: Record<string, unknown>) {
    return actorFromRequest(request, this.trace.current()?.traceId ?? null);
  }

  @Get()
  async list(
    @Req() request: Record<string, unknown>,
    @Query('status') status?: string,
  ): Promise<ApiSuccess<unknown>> {
    const filter =
      status === 'APPROVED' || status === 'REJECTED' || status === 'PENDING'
        ? (status as TemplatePublicationState)
        : null;
    return toHttpResponse(await this.controller.listPublications(this.actor(request), filter));
  }

  @Post(':publicationId/review')
  async review(
    @Param('publicationId') publicationId: string,
    @Req() request: Record<string, unknown>,
    @Body() body: unknown,
  ): Promise<ApiSuccess<unknown>> {
    const envelope = parseFormRequestEnvelope(body);
    const input = envelope.input ?? {};
    return toHttpResponse(
      await this.controller.reviewPublication(this.actor(request), publicationId, {
        decision: input.decision as 'APPROVE' | 'REJECT',
        reason: input.reason === null ? null : String(input.reason),
      }),
    );
  }
}
