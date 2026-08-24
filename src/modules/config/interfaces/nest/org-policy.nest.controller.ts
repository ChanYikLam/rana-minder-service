/**
 * 组织端配置端点 Nest 适配控制器（interfaces/nest；CFG-002/003 社团侧）。
 *
 * 路由（作用域由路径 clubId 冻结；守卫未认证 401；club:config:manage 在命令内部判定）：
 * - GET  /api/org/:clubId/config/policies            本社团生效策略（作用域+生效时间）
 * - PUT  /api/org/:clubId/config/policies/:key       设置本社团默认值（限平台允许范围）
 * - GET  /api/org/:clubId/config/cohorts             届次列表
 * - POST /api/org/:clubId/config/cohorts             创建届次（缺省关联当前学年）
 * - POST /api/org/:clubId/config/cohorts/:cohortId/rename  届次改名
 */

import {
  Body,
  Controller,
  Get,
  HttpException,
  Inject,
  Param,
  Post,
  Put,
  Req,
  UseGuards,
} from '@nestjs/common';

import { randomUUID } from 'node:crypto';

import type { ApiSuccess } from '../../../../common/contracts/api-envelope';
import type { PolicyKey } from '../../domain/models/scoped-policy';
import {
  GET_RESOLVED_POLICIES_QUERY,
  SET_CLUB_POLICY_COMMAND,
  CREATE_COHORT_COMMAND,
  RENAME_COHORT_COMMAND,
  LIST_COHORTS_QUERY,
  CONFIG_MEMBERSHIP_PORT,
} from '../../tokens';
import type { ClubMembershipPort } from '../../application/ports';
import { ConfigAuthGuard } from './config-auth.guard';
import { configActorFromRequest, toHttpResponse } from './config-response-mapper';
import { parseConfigRequestEnvelope } from '../http/config-envelope';
import { toApiError } from '../http/config-error-http';
import type { GetResolvedPoliciesQuery } from '../../application/queries/get-policies.query';
import type {
  CreateCohortCommand,
  RenameCohortCommand,
} from '../../application/commands/academic-year.commands';
import type { ListCohortsQuery } from '../../application/commands/academic-year.commands';
import type { SetClubPolicyCommand } from '../../application/commands/policy.commands';

@UseGuards(ConfigAuthGuard)
@Controller('api/org/:clubId/config')
export class OrgPolicyNestController {
  constructor(
    @Inject(GET_RESOLVED_POLICIES_QUERY)
    private readonly resolvedPolicies: GetResolvedPoliciesQuery,
    @Inject(SET_CLUB_POLICY_COMMAND)
    private readonly setClubPolicy: SetClubPolicyCommand,
    @Inject(CREATE_COHORT_COMMAND)
    private readonly createCohort: CreateCohortCommand,
    @Inject(RENAME_COHORT_COMMAND)
    private readonly renameCohort: RenameCohortCommand,
    @Inject(LIST_COHORTS_QUERY)
    private readonly listCohorts: ListCohortsQuery,
    @Inject(CONFIG_MEMBERSHIP_PORT)
    private readonly membership: ClubMembershipPort,
  ) {}

  private async run(promise: Promise<unknown>): Promise<ApiSuccess<unknown>> {
    try {
      return toHttpResponse({ ok: true, value: await promise });
    } catch (error) {
      const mapped = toApiError(error);
      throw new HttpException(mapped.body, mapped.status);
    }
  }

  /** 创建届次的稳定标识：服务端生成 UUID（对象标识用稳定 UUID 约定，api-paths） */
  private newId(): string {
    return randomUUID();
  }

  @Get('policies')
  async getPolicies(
    @Param('clubId') clubId: string,
    @Req() request: Record<string, unknown>,
  ): Promise<ApiSuccess<unknown>> {
    const subjectId = configActorFromRequest(request).subjectId;
    return this.run(this.resolvedPolicies.execute({ clubId, subjectId }));
  }

  @Put('policies/:key')
  async putPolicy(
    @Param('clubId') clubId: string,
    @Param('key') key: string,
    @Req() request: Record<string, unknown>,
    @Body() body: unknown,
  ): Promise<ApiSuccess<unknown>> {
    const input = parseConfigRequestEnvelope(body).input as { value?: number };
    return this.run(
      this.setClubPolicy.execute({
        clubId,
        subjectId: configActorFromRequest(request).subjectId,
        now: new Date(),
        key: key as PolicyKey,
        value: input.value ?? NaN,
      }),
    );
  }

  @Get('cohorts')
  async getCohorts(
    @Param('clubId') clubId: string,
    @Req() request: Record<string, unknown>,
  ): Promise<ApiSuccess<unknown>> {
    const subjectId = configActorFromRequest(request).subjectId;
    return this.run(this.listCohorts.execute({ clubId, subjectId }));
  }

  @Post('cohorts')
  async postCohort(
    @Param('clubId') clubId: string,
    @Req() request: Record<string, unknown>,
    @Body() body: unknown,
  ): Promise<ApiSuccess<unknown>> {
    const input = parseConfigRequestEnvelope(body).input as {
      name?: string;
      academicYearName?: string;
    };
    return this.run(
      this.createCohort.execute({
        clubId,
        subjectId: configActorFromRequest(request).subjectId,
        now: new Date(),
        name: input.name ?? '',
        academicYearName: input.academicYearName,
        cohortId: this.newId(),
      }),
    );
  }

  @Post('cohorts/:cohortId/rename')
  async postRenameCohort(
    @Param('clubId') clubId: string,
    @Param('cohortId') cohortId: string,
    @Req() request: Record<string, unknown>,
    @Body() body: unknown,
  ): Promise<ApiSuccess<unknown>> {
    const input = parseConfigRequestEnvelope(body).input as { newName?: string };
    return this.run(
      this.renameCohort.execute({
        clubId,
        cohortId,
        subjectId: configActorFromRequest(request).subjectId,
        now: new Date(),
        newName: input.newName ?? '',
      }),
    );
  }
}
