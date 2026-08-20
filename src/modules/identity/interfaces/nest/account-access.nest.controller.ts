/**
 * 账号访问端点 Nest 适配控制器（interfaces/nest；接口清单 §4）。
 *
 * 路由：GET /api/auth/session → 本人资料 + 账号访问状态（降级/剩余窗口）。
 * checkAccess（SRS-FAIL-001 逐请求能力判定）为服务端守卫输入，不在清单暴露
 * 独立端点，不注册路由（未登记路径拒绝，API-EP-002）。
 */

import { Controller, Get, Inject, Req, UseGuards } from '@nestjs/common';

import { TRACE_CONTEXT } from '../../../../platform/observability/tracing/tokens';
import type { TraceContextAdapter } from '../../../../platform/observability/infrastructure/trace-context.adapter';
import { ACCOUNT_ACCESS_CONTROLLER } from '../../tokens';
import type { AccountAccessController, SessionResponse } from '../controllers/account-access.controller';
import { AuthGuard } from './auth.guard';
import { toHttpResponse, actorFromRequest } from './response-mapper';
import type { ApiSuccess } from '../../../../common/contracts/api-envelope';

@UseGuards(AuthGuard)
@Controller('api/auth')
export class AccountAccessNestController {
  constructor(
    @Inject(ACCOUNT_ACCESS_CONTROLLER)
    private readonly controller: AccountAccessController,
    @Inject(TRACE_CONTEXT)
    private readonly trace: TraceContextAdapter,
  ) {}

  @Get('session')
  async getSession(@Req() request: Record<string, unknown>): Promise<ApiSuccess<SessionResponse>> {
    return toHttpResponse(await this.controller.getSession(this.actor(request)));
  }

  private actor(request: Record<string, unknown>) {
    return actorFromRequest(request, this.trace.current()?.traceId ?? null);
  }
}