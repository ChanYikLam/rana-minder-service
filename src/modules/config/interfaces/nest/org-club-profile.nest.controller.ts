/**
 * 组织端展示资料端点 Nest 适配控制器（interfaces/nest；CFG-001，5.5.1）。
 *
 * 路由（作用域由路径 clubId 冻结；守卫未认证 401）：
 * - GET /api/org/:clubId/config/profile —— 管理端完整视图：完整快照+修改历史+
 *   Casdoor Group 对应关系回显（超管后台核对「展示名↔Group 名」）
 * - PUT /api/org/:clubId/config/profile —— 修改展示资料：立即生效无需审批；
 *   expectedVersion 乐观锁（不匹配 409 CFG_VERSION_CONFLICT）；onBehalf（超管
 *   代改）由命令内部按授权身份服务端推导，不采纳请求方自报
 */

import {
  Body,
  Controller,
  Get,
  HttpException,
  Inject,
  Param,
  Put,
  Req,
  UseGuards,
} from '@nestjs/common';

import type { ApiSuccess } from '../../../../common/contracts/api-envelope';
import { GET_CLUB_PROFILE_QUERY, UPDATE_CLUB_PROFILE_COMMAND } from '../../tokens';
import type { GetClubProfileQuery } from '../../application/queries/get-club-profile.query';
import type { UpdateClubProfileCommand } from '../../application/commands/update-club-profile.command';
import type { ClubProfileUpdateInput } from '../../domain/models/club-profile';
import { ConfigAuthGuard } from './config-auth.guard';
import { configActorFromRequest, toHttpResponse } from './config-response-mapper';
import { parseConfigRequestEnvelope } from '../http/config-envelope';
import { toApiError } from '../http/config-error-http';

@UseGuards(ConfigAuthGuard)
@Controller('api/org/:clubId/config')
export class OrgClubProfileNestController {
  constructor(
    @Inject(GET_CLUB_PROFILE_QUERY)
    private readonly getQuery: GetClubProfileQuery,
    @Inject(UPDATE_CLUB_PROFILE_COMMAND)
    private readonly updateCommand: UpdateClubProfileCommand,
  ) {}

  private async run(promise: Promise<unknown>): Promise<ApiSuccess<unknown>> {
    try {
      const value = await promise;
      return toHttpResponse({ ok: true, value });
    } catch (error) {
      const mapped = toApiError(error);
      throw new HttpException(mapped.body, mapped.status);
    }
  }

  @Get('profile')
  async getProfile(
    @Param('clubId') clubId: string,
    @Req() request: Record<string, unknown>,
  ): Promise<ApiSuccess<unknown>> {
    const session = configActorFromRequest(request);
    return this.run(this.getQuery.execute({ clubId, actor: session.subjectId }));
  }

  @Put('profile')
  async putProfile(
    @Param('clubId') clubId: string,
    @Req() request: Record<string, unknown>,
    @Body() body: unknown,
  ): Promise<ApiSuccess<unknown>> {
    const session = configActorFromRequest(request);
    const env = parseConfigRequestEnvelope(body);
    const patch = (env.input ?? {}) as ClubProfileUpdateInput;
    return this.run(
      this.updateCommand.execute({
        clubId,
        actor: session.subjectId,
        now: new Date(),
        expectedVersion: env.expectedVersion,
        patch,
      }),
    );
  }
}
