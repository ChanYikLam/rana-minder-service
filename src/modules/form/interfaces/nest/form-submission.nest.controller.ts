/**
 * 组织表单提交端点 Nest 适配控制器（interfaces/nest；FORM-002）。
 *
 * 路由：POST /api/org/:clubId/forms/:formId/submissions（提交）、
 * POST /api/org/:clubId/submissions/:submissionId/revise（修订）、
 * GET /api/org/:clubId/forms/:formId/submissions（按表单列表）、
 * GET /api/org/:clubId/submissions（按作用域列表）。
 * 作用域由路径 clubId 冻结（IFC-GEN-001）。
 */

import { Body, Controller, Get, Inject, Param, Post, Req, UseGuards } from '@nestjs/common';

import { TRACE_CONTEXT } from '../../../../platform/observability/tracing/tokens';
import type { TraceContextAdapter } from '../../../../platform/observability/infrastructure/trace-context.adapter';
import { FORM_SUBMISSION_CONTROLLER } from '../../tokens';
import type { FormSubmissionController } from '../controllers/form-submission.controller';
import { FormAuthGuard } from './form-auth.guard';
import { toHttpResponse, actorFromRequest } from './form-response-mapper';
import { parseFormRequestEnvelope } from '../http/form-envelope';
import type { ApiSuccess } from '../../../../common/contracts/api-envelope';
import { formScopeOf } from '../../domain/models/form-scope';

@UseGuards(FormAuthGuard)
@Controller('api/org/:clubId')
export class FormSubmissionNestController {
  constructor(
    @Inject(FORM_SUBMISSION_CONTROLLER)
    private readonly controller: FormSubmissionController,
    @Inject(TRACE_CONTEXT)
    private readonly trace: TraceContextAdapter,
  ) {}

  private scope(clubId: string) {
    return formScopeOf('club', clubId);
  }

  private actor(request: Record<string, unknown>) {
    return actorFromRequest(request, this.trace.current()?.traceId ?? null);
  }

  @Post('forms/:formId/submissions')
  async submit(
    @Param('clubId') clubId: string,
    @Param('formId') formId: string,
    @Req() request: Record<string, unknown>,
    @Body() body: unknown,
  ): Promise<ApiSuccess<unknown>> {
    const envelope = parseFormRequestEnvelope(body);
    const input = envelope.input ?? {};
    return toHttpResponse(
      await this.controller.submit(this.actor(request), this.scope(clubId), {
        formId,
        versionNumber: Number(input.versionNumber),
        values: (input.values ?? {}) as Record<string, unknown>,
        idempotencyKey: envelope.idempotencyKey,
      }),
    );
  }

  @Post('submissions/:submissionId/revise')
  async revise(
    @Param('clubId') clubId: string,
    @Param('submissionId') submissionId: string,
    @Req() request: Record<string, unknown>,
    @Body() body: unknown,
  ): Promise<ApiSuccess<unknown>> {
    const envelope = parseFormRequestEnvelope(body);
    const input = envelope.input ?? {};
    return toHttpResponse(
      await this.controller.revise(this.actor(request), submissionId, {
        values: (input.values ?? {}) as Record<string, unknown>,
      }),
    );
  }

  @Get('forms/:formId/submissions')
  async listByForm(
    @Param('clubId') clubId: string,
    @Param('formId') formId: string,
    @Req() request: Record<string, unknown>,
  ): Promise<ApiSuccess<unknown>> {
    return toHttpResponse(
      await this.controller.list(this.actor(request), this.scope(clubId), formId),
    );
  }

  @Get('submissions')
  async listByScope(
    @Param('clubId') clubId: string,
    @Req() request: Record<string, unknown>,
  ): Promise<ApiSuccess<unknown>> {
    return toHttpResponse(await this.controller.list(this.actor(request), this.scope(clubId)));
  }
}
