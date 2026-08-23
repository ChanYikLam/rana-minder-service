/**
 * 申请人自助联合端点 Nest 适配控制器（interfaces/nest；JNT-003/004/005/006）。
 *
 * 与组织管理命名空间（api/org/:clubId/joint）分离，面向申请人本人：
 * - POST /api/applicant/joint/activities/:activityId/applications  创建联合申请
 * - POST /api/applicant/joint/applications/:applicationId/submit   提交联合申请
 * - GET  /api/applicant/joint/activities/:activityId/channel       获取报名通道
 * - GET  /api/applicant/joint/applications/:applicationId          获取联合申请
 * - GET  /api/applicant/joint/interviews/:interviewId              获取联合面试
 * - GET  /api/applicant/joint/applications/:applicationId/conclusions  列出社团结论
 */

import { Body, Controller, Get, Inject, Param, Post, Req, UseGuards } from '@nestjs/common';

import { TRACE_CONTEXT } from '../../../../platform/observability/tracing/tokens';
import type { TraceContextAdapter } from '../../../../platform/observability/infrastructure/trace-context.adapter';
import { JOINT_CONTROLLER } from '../../tokens';
import type { JointController } from '../controllers/joint.controller';
import { JointAuthGuard } from './joint-auth.guard';
import { toHttpResponse, actorFromRequest } from './joint-response-mapper';
import { parseJointRequestEnvelope } from '../http/joint-envelope';
import {
  requireNumber,
  requireRecord,
  requireString,
  requireStringOrNull,
} from '../http/joint-request-validation';
import type { ApiSuccess } from '../../../../common/contracts/api-envelope';

@UseGuards(JointAuthGuard)
@Controller('api/applicant/joint')
export class ApplicantJointNestController {
  constructor(
    @Inject(JOINT_CONTROLLER)
    private readonly controller: JointController,
    @Inject(TRACE_CONTEXT)
    private readonly trace: TraceContextAdapter,
  ) {}

  private actor(request: Record<string, unknown>) {
    return actorFromRequest(request, this.trace.current()?.traceId ?? null);
  }

  @Post('activities/:activityId/applications')
  async createApplication(
    @Param('activityId') activityId: string,
    @Req() request: Record<string, unknown>,
  ): Promise<ApiSuccess<unknown>> {
    const actor = this.actor(request);
    return toHttpResponse(
      await this.controller.createApplication(actor, {
        jointActivityId: activityId,
        applicantId: actor.subjectId,
      }),
    );
  }

  @Post('applications/:applicationId/submit')
  async submitApplication(
    @Param('applicationId') applicationId: string,
    @Req() request: Record<string, unknown>,
    @Body() body: unknown,
  ): Promise<ApiSuccess<unknown>> {
    const input = requireRecord(parseJointRequestEnvelope(body).input, 'input');
    const formRefRaw = requireRecord(input.formRef, 'formRef');
    const formRef = {
      formId: requireString(formRefRaw.formId, 'formRef.formId'),
      submissionId: requireString(formRefRaw.submissionId, 'formRef.submissionId'),
      versionNumber: requireNumber(formRefRaw.versionNumber, 'formRef.versionNumber'),
    };
    const consentSnapshotHash = requireString(input.consentSnapshotHash, 'consentSnapshotHash');
    const sharedNote = requireStringOrNull(input.sharedNote, 'sharedNote');
    return toHttpResponse(
      await this.controller.submitApplication(this.actor(request), {
        applicationId,
        formRef,
        consentSnapshotHash,
        sharedNote,
      }),
    );
  }

  @Get('activities/:activityId/channel')
  async getChannel(
    @Param('activityId') activityId: string,
    @Req() request: Record<string, unknown>,
  ): Promise<ApiSuccess<unknown>> {
    return toHttpResponse(await this.controller.getChannel(this.actor(request), activityId));
  }

  @Get('applications/:applicationId')
  async getApplication(
    @Param('applicationId') applicationId: string,
    @Req() request: Record<string, unknown>,
  ): Promise<ApiSuccess<unknown>> {
    return toHttpResponse(await this.controller.getApplication(this.actor(request), applicationId));
  }

  @Get('interviews/:interviewId')
  async getInterview(
    @Param('interviewId') interviewId: string,
    @Req() request: Record<string, unknown>,
  ): Promise<ApiSuccess<unknown>> {
    return toHttpResponse(await this.controller.getInterview(this.actor(request), interviewId));
  }

  @Get('applications/:applicationId/conclusions')
  async listConclusions(
    @Param('applicationId') applicationId: string,
    @Req() request: Record<string, unknown>,
  ): Promise<ApiSuccess<unknown>> {
    return toHttpResponse(
      await this.controller.listConclusions(this.actor(request), applicationId),
    );
  }
}
