/**
 * 资料端点 Nest 适配控制器（interfaces/nest；接口清单 §4）。
 *
 * 路由：GET/PUT /api/auth/profile、POST /api/auth/profile/send-email-code、
 * POST /api/auth/profile/verify-email、POST /api/auth/profile/sync-conflict。
 * 全部经 AuthGuard 认证；subjectId 恒来自会话（AUT：targetId 不被采纳）。
 */

import {
  Body,
  Controller,
  Get,
  Inject,
  Post,
  Put,
  Req,
  UseGuards,
} from '@nestjs/common';

import { TRACE_CONTEXT } from '../../../../platform/observability/tracing/tokens';
import type { TraceContextAdapter } from '../../../../platform/observability/infrastructure/trace-context.adapter';
import { PROFILES_CONTROLLER } from '../../tokens';
import type { ProfilesController, MyProfileResponse, SendEmailCodeResponse } from '../controllers/profiles.controller';
import { AuthGuard } from './auth.guard';
import { toHttpResponse, actorFromRequest } from './response-mapper';
import type { ApiSuccess } from '../../../../common/contracts/api-envelope';

@UseGuards(AuthGuard)
@Controller('api/auth/profile')
export class ProfilesNestController {
  constructor(
    @Inject(PROFILES_CONTROLLER)
    private readonly controller: ProfilesController,
    @Inject(TRACE_CONTEXT)
    private readonly trace: TraceContextAdapter,
  ) {}

  @Get()
  async getMyProfile(@Req() request: Record<string, unknown>): Promise<ApiSuccess<MyProfileResponse>> {
    return toHttpResponse(await this.controller.getMyProfile(this.actor(request)));
  }

  @Put()
  async saveMyProfile(
    @Req() request: Record<string, unknown>,
    @Body() body: unknown,
  ): Promise<ApiSuccess<MyProfileResponse>> {
    return toHttpResponse(await this.controller.saveMyProfile(this.actor(request), body));
  }

  @Post('send-email-code')
  async sendEmailCode(
    @Req() request: Record<string, unknown>,
    @Body() body: unknown,
  ): Promise<ApiSuccess<SendEmailCodeResponse>> {
    return toHttpResponse(await this.controller.sendEmailCode(this.actor(request), body));
  }

  @Post('verify-email')
  async verifyEmail(
    @Req() request: Record<string, unknown>,
    @Body() body: unknown,
  ): Promise<ApiSuccess<{ readonly emailVerified: true }>> {
    return toHttpResponse(await this.controller.verifyEmail(this.actor(request), body));
  }

  @Post('sync-conflict')
  async resolveSyncConflict(
    @Req() request: Record<string, unknown>,
    @Body() body: unknown,
  ): Promise<ApiSuccess<MyProfileResponse>> {
    return toHttpResponse(await this.controller.resolveSyncConflict(this.actor(request), body));
  }

  private actor(request: Record<string, unknown>) {
    return actorFromRequest(request, this.trace.current()?.traceId ?? null);
  }
}