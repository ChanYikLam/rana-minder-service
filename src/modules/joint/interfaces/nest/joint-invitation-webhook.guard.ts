/**
 * 邀请回调 Webhook 守卫（interfaces/nest；JNT-005 邀请接受/拒绝回调）。
 *
 * INV-001 邀请服务回调联合活动服务时，使用 webhook 鉴权而非会话认证。
 * 守卫调用 JointInvitationWebhookProvider.verify(request) 校验签名与主体，
 * 校验失败 → 401（fail-closed）。校验成功将受信 invitationId 挂载到
 * request[JOINT_WEBHOOK_INVITATION_ID]，供控制器传入用例做绑定校验，避免
 * 错配邀请篡改结论。
 *
 * 真实实现待 DEP-Q-001/002 锁定后替换；当前 NotWired 桩一律返回 null → 401。
 */

import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
} from '@nestjs/common';

import { TRACE_CONTEXT } from '../../../../platform/observability/tracing/tokens';
import type { TraceContextAdapter } from '../../../../platform/observability/infrastructure/trace-context.adapter';
import { generateTraceId } from '../../../../platform/observability/domain/services/trace-id.generator';
import { JOINT_INVITATION_WEBHOOK_PROVIDER } from '../../tokens';

export const JOINT_WEBHOOK_INVITATION_ID = 'jointWebhookInvitationId';

export interface JointInvitationWebhookProvider {
  verify(request: Record<string, unknown>): Promise<{ invitationId: string } | null>;
}

@Injectable()
export class JointInvitationWebhookGuard implements CanActivate {
  constructor(
    @Inject(JOINT_INVITATION_WEBHOOK_PROVIDER)
    private readonly webhookAuth: JointInvitationWebhookProvider,
    @Inject(TRACE_CONTEXT)
    private readonly trace: TraceContextAdapter,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Record<string, unknown>>();
    const verified = await this.webhookAuth.verify(request);
    if (verified === null) {
      throw new HttpException(
        {
          code: 'JNT-ERR-013',
          message: '邀请回调鉴权失败',
          supportId: this.trace.current()?.traceId ?? generateTraceId(),
        },
        HttpStatus.UNAUTHORIZED,
      );
    }
    request[JOINT_WEBHOOK_INVITATION_ID] = verified.invitationId;
    return true;
  }
}

export function jointWebhookInvitationIdFromRequest(request: Record<string, unknown>): string {
  return request[JOINT_WEBHOOK_INVITATION_ID] as string;
}

export class NotWiredJointInvitationWebhookAuth implements JointInvitationWebhookProvider {
  async verify(): Promise<{ invitationId: string } | null> {
    return null;
  }
}
