/**
 * 邀请回调 Webhook 控制器（interfaces/nest；JNT-005）。
 *
 * 仅承载 INV-001 邀请服务的接受/拒绝回调，使用 JointInvitationWebhookGuard
 * 鉴权（非会话）。受信 invitationId 来自守卫挂载的 request，传入用例做与
 * conclusion.invitationId 的绑定校验，避免错配邀请篡改结论。
 */

import { Controller, Inject, Param, Post, Req, UseGuards } from '@nestjs/common';

import { JOINT_CONTROLLER } from '../../tokens';
import type { JointController } from '../controllers/joint.controller';
import {
  JointInvitationWebhookGuard,
  jointWebhookInvitationIdFromRequest,
} from './joint-invitation-webhook.guard';
import { toHttpResponse } from './joint-response-mapper';
import type { ApiSuccess } from '../../../../common/contracts/api-envelope';

@UseGuards(JointInvitationWebhookGuard)
@Controller('api/org/:clubId/joint')
export class JointInvitationWebhookController {
  constructor(
    @Inject(JOINT_CONTROLLER)
    private readonly controller: JointController,
  ) {}

  @Post('conclusions/:conclusionId/accept')
  async handleInvitationAccepted(
    @Param('clubId') _clubId: string,
    @Param('conclusionId') conclusionId: string,
    @Req() request: Record<string, unknown>,
  ): Promise<ApiSuccess<unknown>> {
    const invitationId = jointWebhookInvitationIdFromRequest(request);
    return toHttpResponse(
      await this.controller.handleInvitationAccepted(conclusionId, invitationId, _clubId),
    );
  }

  @Post('conclusions/:conclusionId/reject')
  async handleInvitationRejected(
    @Param('clubId') _clubId: string,
    @Param('conclusionId') conclusionId: string,
    @Req() request: Record<string, unknown>,
  ): Promise<ApiSuccess<unknown>> {
    const invitationId = jointWebhookInvitationIdFromRequest(request);
    return toHttpResponse(
      await this.controller.handleInvitationRejected(conclusionId, invitationId, _clubId),
    );
  }
}
