/**
 * 平台配置管理端点 Nest 适配控制器（interfaces/nest；CFG-002/003/004/005）。
 *
 * 路由（守卫未认证 401；超管权限在命令内部 fail-closed）：
 * - GET  /api/admin/config/policies                          平台策略条目+留痕
 * - PUT  /api/admin/config/policies/:key                     设置平台默认值与允许范围
 * - POST /api/admin/config/academic-year/boundary            调整学年分界规则（未来规则）
 * - GET  /api/admin/config/academic-year/current             当前学年+已知学年
 * - GET  /api/admin/config/field-mapping                     字段映射草稿
 * - PUT  /api/admin/config/field-mapping/draft               保存映射草稿
 * - POST /api/admin/config/field-mapping/activate-real-data  启用真实数据处理
 * - POST /api/admin/config/field-mapping/publish             发布（测试凭证+预览+二次确认）
 * - GET  /api/admin/config/roots/:rootId                     配置版本线
 *
 * 业务字段只读信封 input（API-GEN-003）；错误统一 toApiError 脱敏输出。
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

import type { ApiSuccess } from '../../../../common/contracts/api-envelope';
import type { PolicyKey } from '../../domain/models/scoped-policy';
import type { FieldMappingEntry } from '../../domain/models/field-mapping';
import {
  CONFIG_POLICY_AUTHORIZATION,
  GET_PLATFORM_POLICIES_QUERY,
  SET_PLATFORM_POLICY_COMMAND,
  UPDATE_ACADEMIC_YEAR_BOUNDARY_COMMAND,
  GET_CURRENT_ACADEMIC_YEAR_QUERY,
  SAVE_FIELD_MAPPING_DRAFT_COMMAND,
  ACTIVATE_FIELD_MAPPING_REAL_DATA_COMMAND,
  PUBLISH_FIELD_MAPPING_COMMAND,
  GET_FIELD_MAPPING_QUERY,
  GET_CONFIG_ROOT_QUERY,
} from '../../tokens';
import { ConfigAuthGuard } from './config-auth.guard';
import { configActorFromRequest, toHttpResponse } from './config-response-mapper';
import { parseConfigRequestEnvelope } from '../http/config-envelope';
import { toApiError } from '../http/config-error-http';
import type { GetPlatformPoliciesQuery } from '../../application/queries/get-policies.query';
import type { SetPlatformPolicyCommand } from '../../application/commands/policy.commands';
import type {
  GetCurrentAcademicYearQuery,
  UpdateAcademicYearBoundaryCommand,
} from '../../application/commands/academic-year.commands';
import type {
  ActivateFieldMappingRealDataCommand,
  GetFieldMappingQuery,
  PublishFieldMappingCommand,
  SaveFieldMappingDraftCommand,
} from '../../application/commands/field-mapping.commands';
import type { GetConfigRootQuery } from '../../application/commands/config-version.commands';
import { cfgErrors } from '../../application/errors';

@UseGuards(ConfigAuthGuard)
@Controller('api/admin/config')
export class AdminConfigNestController {
  constructor(
    @Inject(GET_PLATFORM_POLICIES_QUERY)
    private readonly platformPolicies: GetPlatformPoliciesQuery,
    @Inject(CONFIG_POLICY_AUTHORIZATION)
    private readonly policyAuthorization: {
      canManagePlatform(subjectId: string): Promise<boolean>;
    },
    @Inject(SET_PLATFORM_POLICY_COMMAND)
    private readonly setPlatformPolicy: SetPlatformPolicyCommand,
    @Inject(UPDATE_ACADEMIC_YEAR_BOUNDARY_COMMAND)
    private readonly updateBoundary: UpdateAcademicYearBoundaryCommand,
    @Inject(GET_CURRENT_ACADEMIC_YEAR_QUERY)
    private readonly currentAcademicYear: GetCurrentAcademicYearQuery,
    @Inject(GET_FIELD_MAPPING_QUERY)
    private readonly getFieldMapping: GetFieldMappingQuery,
    @Inject(SAVE_FIELD_MAPPING_DRAFT_COMMAND)
    private readonly saveFieldMappingDraft: SaveFieldMappingDraftCommand,
    @Inject(ACTIVATE_FIELD_MAPPING_REAL_DATA_COMMAND)
    private readonly activateRealData: ActivateFieldMappingRealDataCommand,
    @Inject(PUBLISH_FIELD_MAPPING_COMMAND)
    private readonly publishFieldMapping: PublishFieldMappingCommand,
    @Inject(GET_CONFIG_ROOT_QUERY)
    private readonly getConfigRoot: GetConfigRootQuery,
  ) {}

  /** 统一执行：Promise 或 thunk（需要前置鉴权的端点传闭包），领域错误统一脱敏映射 */
  private async run(op: Promise<unknown> | (() => Promise<unknown>)): Promise<ApiSuccess<unknown>> {
    try {
      const value = await (typeof op === 'function' ? op() : op);
      return toHttpResponse({ ok: true, value });
    } catch (error) {
      const mapped = toApiError(error);
      throw new HttpException(mapped.body, mapped.status);
    }
  }

  private actor(request: Record<string, unknown>) {
    return configActorFromRequest(request).subjectId;
  }

  /** 平台策略条目+修改留痕：仅超管可见（ORG-029） */
  @Get('policies')
  async listPolicies(@Req() request: Record<string, unknown>): Promise<ApiSuccess<unknown>> {
    const subjectId = this.actor(request);
    return this.run(async () => {
      if (!(await this.policyAuthorization.canManagePlatform(subjectId))) {
        throw cfgErrors.forbidden('仅平台超管可查看平台策略');
      }
      return this.platformPolicies.execute();
    });
  }

  @Put('policies/:key')
  async putPolicy(
    @Param('key') key: string,
    @Req() request: Record<string, unknown>,
    @Body() body: unknown,
  ): Promise<ApiSuccess<unknown>> {
    const input = parseConfigRequestEnvelope(body).input as {
      defaultValue?: number;
      allowedMin?: number;
      allowedMax?: number;
    };
    return this.run(
      this.setPlatformPolicy.execute({
        subjectId: this.actor(request),
        now: new Date(),
        key: key as PolicyKey,
        defaultValue: input.defaultValue ?? NaN,
        allowedMin: input.allowedMin ?? NaN,
        allowedMax: input.allowedMax ?? NaN,
      }),
    );
  }

  @Post('academic-year/boundary')
  async postBoundary(
    @Req() request: Record<string, unknown>,
    @Body() body: unknown,
  ): Promise<ApiSuccess<unknown>> {
    const input = parseConfigRequestEnvelope(body).input as {
      month?: number;
      day?: number;
      timeZone?: string;
      generateCount?: number;
    };
    return this.run(
      this.updateBoundary.execute({
        subjectId: this.actor(request),
        now: new Date(),
        month: input.month ?? NaN,
        day: input.day ?? NaN,
        timeZone: input.timeZone ?? '',
        generateCount: input.generateCount,
      }),
    );
  }

  /** 当前学年+已知学年（平台校历数据）：/admin 命名空间内与其他端点一致要求超管 */
  @Get('academic-year/current')
  async getCurrentAcademicYear(
    @Req() request: Record<string, unknown>,
  ): Promise<ApiSuccess<unknown>> {
    const subjectId = this.actor(request);
    return this.run(async () => {
      if (!(await this.policyAuthorization.canManagePlatform(subjectId))) {
        throw cfgErrors.forbidden('仅平台超管可查看平台学年配置');
      }
      return this.currentAcademicYear.execute({ now: new Date() });
    });
  }

  @Get('field-mapping')
  async getFieldMappingDraft(
    @Req() request: Record<string, unknown>,
  ): Promise<ApiSuccess<unknown>> {
    return this.run(this.getFieldMapping.execute({ subjectId: this.actor(request) }));
  }

  @Put('field-mapping/draft')
  async putFieldMappingDraft(
    @Req() request: Record<string, unknown>,
    @Body() body: unknown,
  ): Promise<ApiSuccess<unknown>> {
    const input = parseConfigRequestEnvelope(body).input as { entries?: FieldMappingEntry[] };
    return this.run(
      this.saveFieldMappingDraft.execute({
        subjectId: this.actor(request),
        now: new Date(),
        entries: input.entries ?? [],
      }),
    );
  }

  @Post('field-mapping/activate-real-data')
  async postActivateRealData(
    @Req() request: Record<string, unknown>,
  ): Promise<ApiSuccess<unknown>> {
    return this.run(
      this.activateRealData.execute({ subjectId: this.actor(request), now: new Date() }),
    );
  }

  @Post('field-mapping/publish')
  async postPublishFieldMapping(
    @Req() request: Record<string, unknown>,
    @Body() body: unknown,
  ): Promise<ApiSuccess<unknown>> {
    const input = parseConfigRequestEnvelope(body).input as {
      testResultRef?: string;
      impactPreview?: { affectedFields?: string[]; estimatedUserCount?: number };
      impactSummary?: string;
      confirmation?: string;
    };
    return this.run(
      this.publishFieldMapping.execute({
        subjectId: this.actor(request),
        now: new Date(),
        testResultRef: input.testResultRef ?? '',
        impactPreview: {
          affectedFields: (input.impactPreview?.affectedFields ?? []) as never,
          estimatedUserCount: input.impactPreview?.estimatedUserCount ?? -1,
        },
        impactSummary: input.impactSummary ?? '',
        confirmation: input.confirmation ?? '',
      }),
    );
  }

  @Get('roots/:rootId')
  async getRoot(
    @Param('rootId') rootId: string,
    @Req() request: Record<string, unknown>,
  ): Promise<ApiSuccess<unknown>> {
    return this.run(this.getConfigRoot.execute({ rootId, subjectId: this.actor(request) }));
  }
}
