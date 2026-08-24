/**
 * 公开社团展示页端点 Nest 适配控制器（interfaces/nest；CFG-001，5.5.1）。
 *
 * 路由：GET /api/explore/clubs/:clubId/profile —— 公开展示页，匿名可达。
 *
 * 可见范围（CFG-001）：未登录可见名称/Logo/简介/公开招新说明；有效登录学生另见
 * 「主动公开」联系方式；本社团成员另见成员范围联系方式与内部说明。作用域在查询
 * 内部解析（viewerSubjectId=null 即匿名）；投影结构性排除成员名单/部门关系/职位
 * 人员（display-visibility-policy 白名单守卫兜底）。公开端点不自动初始化资料，
 * 不存在 → 404（避免匿名请求触发写库）。
 */

import { Controller, Get, HttpException, Inject, Param, Req } from '@nestjs/common';

import type { ApiSuccess } from '../../../../common/contracts/api-envelope';
import { CONFIG_AUTH_SESSION_PROVIDER, GET_PUBLIC_CLUB_PROFILE_QUERY } from '../../tokens';
import type { GetPublicClubProfileQuery } from '../../application/queries/get-public-club-profile.query';
import type { ConfigAuthSession, ConfigAuthSessionProvider } from './config-auth-session';
import { toHttpResponse } from './config-response-mapper';
import { toApiError } from '../http/config-error-http';

@Controller('api/explore/clubs/:clubId')
export class PublicClubProfileNestController {
  constructor(
    @Inject(GET_PUBLIC_CLUB_PROFILE_QUERY)
    private readonly query: GetPublicClubProfileQuery,
    @Inject(CONFIG_AUTH_SESSION_PROVIDER)
    private readonly sessions: ConfigAuthSessionProvider,
  ) {}

  /** 公开端点：会话可选；解析失败/未登录一律按匿名投影，不抛 401 */
  private async optionalSubjectId(request: Record<string, unknown>): Promise<string | null> {
    try {
      const session: ConfigAuthSession | null = await this.sessions.resolveSession(
        request as never,
      );
      return session?.subjectId ?? null;
    } catch {
      return null;
    }
  }

  @Get('profile')
  async getPublicProfile(
    @Param('clubId') clubId: string,
    @Req() request: Record<string, unknown>,
  ): Promise<ApiSuccess<unknown>> {
    try {
      const viewerSubjectId = await this.optionalSubjectId(request);
      const view = await this.query.execute({ clubId, viewerSubjectId });
      return toHttpResponse({ ok: true, value: view });
    } catch (error) {
      const mapped = toApiError(error);
      throw new HttpException(mapped.body, mapped.status);
    }
  }
}
