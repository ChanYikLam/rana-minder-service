/**
 * 组织表单端点 Nest 适配控制器（interfaces/nest；接口清单 §13 组织侧）。
 *
 * 路由：GET/POST /api/org/:clubId/forms、GET /api/org/:clubId/templates 等。
 * 作用域由路径 clubId 冻结（IFC-GEN-001）；信封解析失败在守卫后按 400/422 返回。
 * 静态段（templates/template-publications）声明先于 :formId 通配（Nest 路由顺序）。
 */

import { Body, Controller, Get, Inject, Param, Post, Req, UseGuards } from '@nestjs/common';

import { TRACE_CONTEXT } from '../../../../platform/observability/tracing/tokens';
import type { TraceContextAdapter } from '../../../../platform/observability/infrastructure/trace-context.adapter';
import { FORM_DESIGN_CONTROLLER } from '../../tokens';
import type { FormDesignController } from '../controllers/form-design.controller';
import { FormAuthGuard } from './form-auth.guard';
import { toHttpResponse, actorFromRequest } from './form-response-mapper';
import { parseFormRequestEnvelope } from '../http/form-envelope';
import type { ApiSuccess } from '../../../../common/contracts/api-envelope';
import { formScopeOf } from '../../domain/models/form-scope';
import type { FormScope } from '../../domain/models/form-scope';

@UseGuards(FormAuthGuard)
@Controller('api/org/:clubId/forms')
export class OrgFormsNestController {
  constructor(
    @Inject(FORM_DESIGN_CONTROLLER)
    private readonly controller: FormDesignController,
    @Inject(TRACE_CONTEXT)
    private readonly trace: TraceContextAdapter,
  ) {}

  private scope(clubId: string): FormScope {
    return formScopeOf('club', clubId);
  }

  private actor(request: Record<string, unknown>) {
    return actorFromRequest(request, this.trace.current()?.traceId ?? null);
  }

  @Get()
  async list(
    @Param('clubId') clubId: string,
    @Req() request: Record<string, unknown>,
  ): Promise<ApiSuccess<unknown>> {
    return toHttpResponse(await this.controller.list(this.actor(request), this.scope(clubId)));
  }

  @Post()
  async create(
    @Param('clubId') clubId: string,
    @Req() request: Record<string, unknown>,
    @Body() body: unknown,
  ): Promise<ApiSuccess<unknown>> {
    const envelope = parseFormRequestEnvelope(body);
    const input = envelope.input ?? {};
    return toHttpResponse(
      await this.controller.create(this.actor(request), this.scope(clubId), {
        title: String(input.title ?? ''),
        description: input.description === null ? null : String(input.description),
        businessFamily: input.businessFamily === null ? null : String(input.businessFamily),
        idempotencyKey: envelope.idempotencyKey,
      }),
    );
  }

  @Get('templates')
  async listTemplates(@Req() request: Record<string, unknown>): Promise<ApiSuccess<unknown>> {
    return toHttpResponse(await this.controller.listTemplates(this.actor(request)));
  }

  @Post('templates/:templateId/copy')
  async copyTemplate(
    @Param('clubId') clubId: string,
    @Param('templateId') templateId: string,
    @Req() request: Record<string, unknown>,
    @Body() body: unknown,
  ): Promise<ApiSuccess<unknown>> {
    const envelope = parseFormRequestEnvelope(body);
    const input = envelope.input ?? {};
    return toHttpResponse(
      await this.controller.copyTemplate(this.actor(request), templateId, this.scope(clubId), {
        title: input.title === null ? null : String(input.title),
        idempotencyKey: envelope.idempotencyKey,
      }),
    );
  }

  @Get(':formId')
  async getDefinition(
    @Param('formId') formId: string,
    @Req() request: Record<string, unknown>,
  ): Promise<ApiSuccess<unknown>> {
    return toHttpResponse(await this.controller.getDefinition(this.actor(request), formId));
  }

  @Get(':formId/designer')
  async getDesignerState(
    @Param('formId') formId: string,
    @Req() request: Record<string, unknown>,
  ): Promise<ApiSuccess<unknown>> {
    return toHttpResponse(await this.controller.getDesignerState(this.actor(request), formId));
  }

  @Post(':formId/designer/save')
  async saveDraft(
    @Param('formId') formId: string,
    @Req() request: Record<string, unknown>,
    @Body() body: unknown,
  ): Promise<ApiSuccess<unknown>> {
    const envelope = parseFormRequestEnvelope(body);
    const input = envelope.input ?? {};
    const fields = Array.isArray(input.fields) ? input.fields : [];
    return toHttpResponse(
      await this.controller.saveDraft(this.actor(request), formId, envelope.expectedVersion ?? 0, {
        fields,
      }),
    );
  }

  @Post(':formId/designer/preview-test')
  async runPreviewTest(
    @Param('formId') formId: string,
    @Req() request: Record<string, unknown>,
    @Body() body: unknown,
  ): Promise<ApiSuccess<unknown>> {
    const envelope = parseFormRequestEnvelope(body);
    const input = envelope.input ?? {};
    return toHttpResponse(
      await this.controller.runPreviewTest(this.actor(request), formId, {
        result: input.result as 'PASSED' | 'FAILED',
        summary: (input.summary ?? {}) as Record<string, unknown>,
      }),
    );
  }

  @Post(':formId/designer/preview-passed')
  async confirmPreviewPassed(
    @Param('formId') formId: string,
    @Req() request: Record<string, unknown>,
  ): Promise<ApiSuccess<unknown>> {
    return toHttpResponse(await this.controller.confirmPreviewPassed(this.actor(request), formId));
  }

  @Post(':formId/publish')
  async publishVersion(
    @Param('formId') formId: string,
    @Req() request: Record<string, unknown>,
    @Body() body: unknown,
  ): Promise<ApiSuccess<unknown>> {
    const envelope = parseFormRequestEnvelope(body);
    return toHttpResponse(
      await this.controller.publishVersion(
        this.actor(request),
        formId,
        envelope.expectedVersion ?? null,
      ),
    );
  }

  @Post(':formId/deprecate')
  async deprecateVersion(
    @Param('formId') formId: string,
    @Req() request: Record<string, unknown>,
    @Body() body: unknown,
  ): Promise<ApiSuccess<unknown>> {
    const envelope = parseFormRequestEnvelope(body);
    return toHttpResponse(
      await this.controller.deprecateVersion(
        this.actor(request),
        formId,
        envelope.expectedVersion ?? null,
      ),
    );
  }

  @Post(':formId/reuse')
  async reuseVersion(
    @Param('formId') formId: string,
    @Req() request: Record<string, unknown>,
    @Body() body: unknown,
  ): Promise<ApiSuccess<unknown>> {
    const envelope = parseFormRequestEnvelope(body);
    const input = envelope.input ?? {};
    const sourceVersion = input.sourceVersion;
    return toHttpResponse(
      await this.controller.reuseVersion(
        this.actor(request),
        formId,
        sourceVersion === null || sourceVersion === undefined ? null : Number(sourceVersion),
      ),
    );
  }

  @Post(':formId/clone')
  async cloneForm(
    @Param('clubId') clubId: string,
    @Param('formId') formId: string,
    @Req() request: Record<string, unknown>,
    @Body() body: unknown,
  ): Promise<ApiSuccess<unknown>> {
    const envelope = parseFormRequestEnvelope(body);
    const input = envelope.input ?? {};
    return toHttpResponse(
      await this.controller.clone(this.actor(request), formId, this.scope(clubId), {
        title: input.title === null ? null : String(input.title),
        idempotencyKey: envelope.idempotencyKey,
      }),
    );
  }

  @Post(':formId/template-publication')
  async requestPublication(
    @Param('formId') formId: string,
    @Req() request: Record<string, unknown>,
    @Body() body: unknown,
  ): Promise<ApiSuccess<unknown>> {
    const envelope = parseFormRequestEnvelope(body);
    const input = envelope.input ?? {};
    return toHttpResponse(
      await this.controller.requestPublication(this.actor(request), formId, {
        note: input.note === null ? null : String(input.note),
        idempotencyKey: envelope.idempotencyKey,
      }),
    );
  }
}
