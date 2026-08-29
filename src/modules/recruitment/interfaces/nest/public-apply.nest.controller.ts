/**
 * 申请人端公开招新端点 Nest 适配控制器（interfaces/nest；接口清单 §11.1）。
 *
 * 联调 2026-08-27 新增：此前申请人侧报名链路仅有 mock 实现，后端缺以下路由，
 * 前端「新生提交面试申请」页面无法联调。本控制器按契约最小接线：
 *
 * - GET  /api/explore/activities/:activityId       → 活动公开详情（公开）
 * - GET  /api/explore/activities/:activityId/form  → 已发布表单版本（公开）
 * - GET  /api/activity/recruitment/:activityId/apply → 本人申请回显（认证；未提交 404 IFC-ERR-015）
 * - POST /api/activity/recruitment/:activityId/apply → 提交申请（认证；SM-REC-003）
 *
 * 写路径复用 RECRUITMENT_CONTROLLER.submitApplication 领域用例（归属校验、
 * 通道开放、批次唯一性、志愿数量规则均在用例内）；本层只做契约映射。
 * answers/allowAdjustment 暂存 qualify_snapshot JSONB（正式表结构待上游收口）。
 */

import { Body, Controller, Get, Inject, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import type { Pool } from 'pg';

import { DB_ADAPTER } from '../../../../adapters/tokens';
import {
  RECRUITMENT_CONTROLLER,
  SAVE_APPLICATION_DRAFT_USE_CASE,
  WITHDRAW_APPLICATION_USE_CASE,
  EXIT_RECRUITMENT_USE_CASE,
} from '../../tokens';
import type { SaveApplicationDraftUseCase } from '../../application/commands/save-application-draft.use-case';
import type { WithdrawApplicationUseCase } from '../../application/commands/withdraw-application.use-case';
import type { ExitRecruitmentUseCase } from '../../application/commands/exit-recruitment.use-case';
import type { RecruitmentController } from '../controllers/recruitment.controller';
import { parseRecruitmentRequestEnvelope } from '../http/recruitment-envelope';
import { RecruitmentAuthGuard, RECRUITMENT_AUTH_SESSION_KEY } from './recruitment-auth.guard';
import type { RecruitmentAuthSession } from './recruitment-auth-session';
import { toHttpResponse } from './recruitment-response-mapper';
import type { ApiSuccess } from '../../../../common/contracts/api-envelope';
import { HttpException } from '@nestjs/common';
import { generateTraceId } from '../../../../platform/observability/domain/services/trace-id.generator';
import {
  PublicRecruitmentReadModel,
  type ApplicationRow,
} from '../../infrastructure/public-recruitment.read-model';

interface ApplyPreference {
  readonly departmentId?: unknown;
}

interface ApplyInput {
  readonly preferences?: readonly ApplyPreference[];
  readonly allowAdjustment?: unknown;
  readonly answers?: unknown;
}

/** 领域申请行 → 契约 RecApplication（接口清单 §11.1 响应 data）。
 * departments 传入活动部门目录时，preferences 补全 departmentName（C5）。 */
export function toRecApplication(
  row: ApplicationRow,
  departments?: ReadonlyArray<{ id: string; name: string }>,
): Record<string, unknown> {
  const snapshot = (row.qualifySnapshot ?? {}) as {
    allowAdjustment?: unknown;
    answers?: unknown;
  };
  const statusMap: Record<string, string> = {
    DRAFT: 'draft',
    SUBMITTED: 'submitted',
    WITHDRAWN: 'draft',
    EXITED: 'exited',
    IDENTITY_EXCEPTION: 'identity_anomaly',
    FINAL_REJECTED: 'not_qualified',
    ADMITTED: 'accepted',
    ACCEPTED: 'accepted',
  };
  const nameOf = (departmentId: string): string | null =>
    departments?.find((d) => d.id === departmentId)?.name ?? null;
  const rawChoices = (row.departmentChoices ?? []) as Array<{
    departmentId?: unknown;
    order?: unknown;
  }>;
  const preferences = rawChoices.map((c) => ({
    order: typeof c.order === 'number' ? c.order : null,
    departmentId: typeof c.departmentId === 'string' ? c.departmentId : '',
    departmentName: typeof c.departmentId === 'string' ? nameOf(c.departmentId) : null,
  }));
  return {
    id: row.id,
    activityId: row.activityId,
    status: statusMap[row.status] ?? row.status.toLowerCase(),
    preferences,
    allowAdjustment: snapshot.allowAdjustment !== false,
    answers: snapshot.answers ?? {},
    formVersion: null,
    submittedAt: row.status === 'SUBMITTED' ? row.updatedAt : null,
    withdrawnAt: null,
    identityAnomalyAt: null,
    recoveryWindowDeadline: null,
    adjustmentDeadline: null,
    adjustmentReason: null,
    notQualifiedReason: null,
    paths: [],
    version: row.revisionNumber,
  };
}

function notFound(): HttpException {
  return new HttpException(
    { code: 'IFC-ERR-015', message: '未找到报名申请', supportId: generateTraceId() },
    404,
  );
}

// ---------------------------------------------------------------------------
// 公开读视图：活动详情 + 表单版本（不要求登录）
// ---------------------------------------------------------------------------

@Controller('api/explore/activities')
export class ExploreActivitiesNestController {
  // 说明：列表路由须注册在 :activityId 之前匹配（本 controller 内 @Get() 无路径冲突）

  constructor(@Inject(DB_ADAPTER) private readonly db: { getPool?: () => Pool }) {}

  private readModel(): PublicRecruitmentReadModel {
    if (typeof this.db.getPool !== 'function') {
      throw new HttpException(
        { code: 'IFC-ERR-014', message: '依赖服务暂不可用', supportId: generateTraceId() },
        503,
      );
    }
    return new PublicRecruitmentReadModel(this.db.getPool());
  }

  /** GET /api/explore/activities（目录列表；契约 §浏览：q/status/limit，游标预留恒 null） */
  @Get()
  async listActivities(
    @Query('q') q?: string,
    @Query('status') status?: string,
  ): Promise<ApiSuccess<unknown>> {
    const items = await this.readModel().listActivitiesPublic({ q, status });
    return { code: 0, data: { items, nextCursor: null } };
  }

  @Get(':activityId')
  async getActivity(@Param('activityId') activityId: string): Promise<ApiSuccess<unknown>> {
    const view = await this.readModel().getActivityPublic(activityId);
    if (!view) throw notFound();
    return { code: 0, data: view };
  }

  @Get(':activityId/form')
  async getForm(@Param('activityId') activityId: string): Promise<ApiSuccess<unknown>> {
    const read = this.readModel();
    const activity = await read.getActivityPublic(activityId);
    if (!activity?.formId) throw notFound();
    const versions = await read.getPublishedFormVersions(activity.formId);
    if (!versions) throw notFound();
    return { code: 0, data: versions };
  }
}

/** 社团目录列表（公开浏览页；GET /api/explore/clubs） */
@Controller('api/explore/clubs')
export class ClubsExploreNestController {
  constructor(@Inject(DB_ADAPTER) private readonly db: { getPool?: () => Pool }) {}

  private readModel(): PublicRecruitmentReadModel {
    if (typeof this.db.getPool !== 'function') {
      throw new HttpException(
        { code: 'IFC-ERR-014', message: '依赖服务暂不可用', supportId: generateTraceId() },
        503,
      );
    }
    return new PublicRecruitmentReadModel(this.db.getPool());
  }

  @Get()
  async listClubs(): Promise<ApiSuccess<unknown>> {
    const items = await this.readModel().listClubsPublic();
    return { code: 0, data: { items, nextCursor: null } };
  }
}

// ---------------------------------------------------------------------------
// 申请人本人申请：回显 + 提交（需登录；subjectId 恒来自会话）
// ---------------------------------------------------------------------------

@UseGuards(RecruitmentAuthGuard)
@Controller('api/activity/recruitment')
export class ApplicantApplyNestController {
  constructor(
    @Inject(DB_ADAPTER) private readonly db: { getPool?: () => Pool },
    @Inject(RECRUITMENT_CONTROLLER)
    private readonly controller: RecruitmentController,
    @Inject(SAVE_APPLICATION_DRAFT_USE_CASE)
    private readonly saveDraftUseCase: SaveApplicationDraftUseCase,
    @Inject(WITHDRAW_APPLICATION_USE_CASE)
    private readonly withdrawUseCase: WithdrawApplicationUseCase,
    @Inject(EXIT_RECRUITMENT_USE_CASE)
    private readonly exitUseCase: ExitRecruitmentUseCase,
  ) {}

  private readModel(): PublicRecruitmentReadModel {
    if (typeof this.db.getPool !== 'function') {
      throw new HttpException(
        { code: 'IFC-ERR-014', message: '依赖服务暂不可用', supportId: generateTraceId() },
        503,
      );
    }
    return new PublicRecruitmentReadModel(this.db.getPool());
  }

  private actor(request: Record<string, unknown>) {
    const session = request[RECRUITMENT_AUTH_SESSION_KEY] as RecruitmentAuthSession | undefined;
    if (!session) {
      throw new HttpException(
        { code: 'REC-ERR-001', message: '未认证或认证失效', supportId: generateTraceId() },
        401,
      );
    }
    return { subjectId: session.subjectId, now: session.now, traceId: generateTraceId() };
  }

  /** GET /api/activity/recruitment/:activityId/apply */
  @Get(':activityId/apply')
  async getMyApplication(
    @Req() request: Record<string, unknown>,
    @Param('activityId') activityId: string,
  ): Promise<ApiSuccess<unknown>> {
    const actor = this.actor(request);
    const read = this.readModel();
    const [row, activity] = await Promise.all([
      read.findApplication(activityId, actor.subjectId),
      read.getActivityPublic(activityId),
    ]);
    if (!row) throw notFound();
    return { code: 0, data: toRecApplication(row, activity?.departments) };
  }

  /** POST /api/activity/recruitment/:activityId/apply（SM-REC-003 draft→submitted） */
  @Post(':activityId/apply')
  async submitApplication(
    @Req() request: Record<string, unknown>,
    @Param('activityId') activityId: string,
    @Body() body: unknown,
  ): Promise<ApiSuccess<unknown>> {
    const actor = this.actor(request);
    const read = this.readModel();

    const channel = await read.findOpenChannel(activityId);
    if (!channel) {
      throw new HttpException(
        { code: 'IFC-ERR-006', message: '报名通道未开放或已截止', supportId: generateTraceId() },
        422,
      );
    }

    const { input, idempotencyKey } = parseRecruitmentRequestEnvelope(body);
    const applyInput = (input ?? {}) as ApplyInput;
    const preferences = (applyInput.preferences ?? [])
      .map((p) => (typeof p?.departmentId === 'string' ? p.departmentId : null))
      .filter((v): v is string => typeof v === 'string');

    if (preferences.length === 0) {
      throw new HttpException(
        { code: 'IFC-ERR-006', message: '请至少选择一个志愿部门', supportId: generateTraceId() },
        422,
      );
    }

    // B2 幂等重放：同键重放直接返回首次成功结果（API-GEN；键由客户端信封携带）
    if (idempotencyKey) {
      const replayed = await read.findIdempotentResult(idempotencyKey, 'submit-application');
      if (replayed) return { code: 0, data: replayed };
    }

    const submitted = await this.controller.submitApplication(actor, {
      activityId,
      channelId: channel.id,
      // 申请归属必须为当前认证账号（用例内二次校验，防冒充）
      applicantId: actor.subjectId,
      departmentChoices: preferences,
      qualifySnapshot: {
        allowAdjustment: applyInput.allowAdjustment !== false,
        answers: applyInput.answers ?? {},
      },
    });

    if (!submitted.ok) {
      return toHttpResponse(submitted);
    }

    // 幂等回读：以库内最新状态组装契约响应（uq_applications_applicant_channel 兜底唯一性）
    const [row, activity] = await Promise.all([
      read.findApplication(activityId, actor.subjectId),
      read.getActivityPublic(activityId),
    ]);
    if (!row) throw notFound();
    const data = toRecApplication(row, activity?.departments);

    if (idempotencyKey) {
      await read.saveIdempotentResult(idempotencyKey, 'submit-application', data);
    }
    return { code: 0, data };
  }

  /**
   * POST /api/activity/recruitment/:activityId/draft（A2）
   * 无申请创建 DRAFT；已有草稿更新 answers；已提交须先撤销。
   */
  @Post(':activityId/draft')
  async saveDraft(
    @Req() request: Record<string, unknown>,
    @Param('activityId') activityId: string,
    @Body() body: unknown,
  ): Promise<ApiSuccess<unknown>> {
    const actor = this.actor(request);
    const read = this.readModel();

    const channel = await read.findOpenChannel(activityId);
    if (!channel) {
      throw new HttpException(
        { code: 'IFC-ERR-006', message: '报名通道未开放或已截止', supportId: generateTraceId() },
        422,
      );
    }
    const { input } = parseRecruitmentRequestEnvelope(body);
    const applyInput = (input ?? {}) as ApplyInput;

    const saved = await this.controller.saveApplicationDraft(actor, {
      activityId,
      channelId: channel.id,
      applicantId: actor.subjectId,
      answers: applyInput.answers ?? {},
    });
    if (!saved.ok) {
      return toHttpResponse(saved);
    }

    const [row, activity] = await Promise.all([
      read.findApplication(activityId, actor.subjectId),
      read.getActivityPublic(activityId),
    ]);
    if (!row) throw notFound();
    return {
      code: 0,
      data: {
        activityId,
        status: 'draft',
        savedAt: new Date().toISOString(),
        ...toRecApplication(row, activity?.departments),
      },
    };
  }

  /**
   * POST /api/activity/recruitment/:activityId/apply/withdraw（A2）
   * SM-REC-003 submitted→draft：仅通道开放未截止且无面试安排/结论可撤销。
   */
  @Post(':activityId/apply/withdraw')
  async withdrawToDraft(
    @Req() request: Record<string, unknown>,
    @Param('activityId') activityId: string,
  ): Promise<ApiSuccess<unknown>> {
    const actor = this.actor(request);
    const read = this.readModel();

    const channel = await read.findOpenChannel(activityId);
    if (!channel) {
      throw new HttpException(
        {
          code: 'IFC-ERR-006',
          message: '报名通道未开放或已截止，不可撤销',
          supportId: generateTraceId(),
        },
        422,
      );
    }
    const withdrawn = await this.controller.withdrawApplication(actor, {
      activityId,
      channelId: channel.id,
      applicantId: actor.subjectId,
    });
    if (!withdrawn.ok) {
      return toHttpResponse(withdrawn);
    }

    const [row, activity] = await Promise.all([
      read.findApplication(activityId, actor.subjectId),
      read.getActivityPublic(activityId),
    ]);
    if (!row) throw notFound();
    return { code: 0, data: toRecApplication(row, activity?.departments) };
  }

  /**
   * POST /api/activity/recruitment/:activityId/withdraw（A2）
   * SM-REC-003 submitted→exited：退出招新（confirm=true 二次确认；响应 data=null）。
   */
  @Post(':activityId/withdraw')
  async exitRecruitment(
    @Req() request: Record<string, unknown>,
    @Param('activityId') activityId: string,
    @Body() body: unknown,
  ): Promise<ApiSuccess<null>> {
    const actor = this.actor(request);
    const read = this.readModel();

    const { input } = parseRecruitmentRequestEnvelope(body);
    const exitInput = (input ?? {}) as { confirm?: unknown };

    const channel = await read.findOpenChannel(activityId);
    if (!channel) {
      throw new HttpException(
        { code: 'IFC-ERR-006', message: '报名通道未开放或已截止', supportId: generateTraceId() },
        422,
      );
    }
    const exited = await this.controller.exitRecruitment(actor, {
      activityId,
      channelId: channel.id,
      applicantId: actor.subjectId,
      confirm: exitInput.confirm === true,
    });
    // toHttpResponse 对 !ok 抛 HttpException（契约成功 data 恒为 null）
    toHttpResponse(exited);
    return { code: 0, data: null };
  }
}
