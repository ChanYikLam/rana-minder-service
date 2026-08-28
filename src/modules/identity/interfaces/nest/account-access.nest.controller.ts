/**
 * 账号访问端点 Nest 适配控制器（interfaces/nest；接口清单 §4）。
 *
 * 路由：POST /api/auth/logout（会话吊销版本语义）。
 *
 * 联调对齐（2026-08-27）：原 @Get('session') 路由已移除——该路径统一由
 * CasdoorSessionController 注册：无 code/state 时委托本控制器领域会话
 * （刷新语义），带 code/state 时走 OIDC 建立。此文件保留 getSession 方法
 * 供委托与测试直接调用（nest-http.spec）。
 * checkAccess（SRS-FAIL-001 逐请求能力判定）为服务端守卫输入，不在清单暴露
 * 独立端点，不注册路由（未登记路径拒绝，API-EP-002）。
 */

import { Controller, Inject, Post, Req, UseGuards } from '@nestjs/common';

import { TRACE_CONTEXT } from '../../../../platform/observability/tracing/tokens';
import type { TraceContextAdapter } from '../../../../platform/observability/infrastructure/trace-context.adapter';
import { ACCOUNT_ACCESS_CONTROLLER } from '../../tokens';
import type {
  AccountAccessController,
  SessionResponse,
} from '../controllers/account-access.controller';
import { AuthGuard } from './auth.guard';
import {
  toHttpResponse,
  actorFromRequest,
  sessionContractFromViews,
  type SessionResponseContract,
} from './response-mapper';
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

  /**
   * 会话刷新读取（不注册路由：路径统一由 CasdoorSessionController 持有，
   * 无 code/state 的 GET /api/auth/session 在其处理器内委托本方法）。
   */
  async getSession(request: Record<string, unknown>): Promise<ApiSuccess<SessionResponseContract>> {
    const actor = this.actor(request);
    const result = await this.controller.getSession(actor);
    if (!result.ok) {
      return toHttpResponse(result);
    }
    return { code: 0, data: sessionContractFromViews(actor.subjectId, result.value) };
  }

  @Post('logout')
  async logout(
    @Req() request: Record<string, unknown>,
  ): Promise<ApiSuccess<{ ok: true; revokedVersion: number }>> {
    return toHttpResponse(await this.controller.logout(this.actor(request)));
  }

  private actor(request: Record<string, unknown>) {
    return actorFromRequest(request, this.trace.current()?.traceId ?? null);
  }
}
