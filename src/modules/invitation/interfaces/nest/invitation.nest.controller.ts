/**
 * 邀请端点 Nest 适配控制器（interfaces/nest；4.5，接口清单 §8 /api/me/invitations/*）。
 *
 * 路由：
 * - GET  /api/me/invitations/recruitment/:invitationId           普通录取邀请状态（本人/发文社团）
 * - POST /api/me/invitations/recruitment/:invitationId/respond   接受/拒绝 { action }
 * - GET  /api/me/invitations/membership/:invitationId            常规入社邀请详情
 * - POST /api/me/invitations/membership/:invitationId/respond    接受/拒绝 { action }
 *
 * 会话：InvitationAuthGuard → INVITATION_AUTH_SESSION_KEY；主体只取服务端会话。
 * 错误映射：IFC-ERR-006→404、IFC-ERR-003→403、IFC-ERR-007→422。
 */

import {
  Body,
  Controller,
  Get,
  HttpException,
  HttpStatus,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { ApiSuccess } from '../../../../common/contracts/api-envelope';
import { InvitationAuthGuard, invitationSessionFromRequest } from './invitation-auth.guard';

import { AcceptInvitationCommand } from '../../application/commands/accept-invitation.command';
import { RejectInvitationCommand } from '../../application/commands/reject-invitation.command';
import { AcceptInvitationError } from '../../application/commands/accept-invitation.command';
import { RejectInvitationError } from '../../application/commands/reject-invitation.command';
import {
  InvitationStatusQuery,
  InvitationStatusQueryError,
} from '../../application/queries/invitation-status.query';
import {
  AcceptRoutineInvitationCommand,
  AcceptRoutineError,
} from '../../application/commands/accept-routine-invitation.command';
import {
  RejectRoutineInvitationCommand,
  RoutineRejectError,
} from '../../application/commands/routine-reject-withdraw.command';
import { RoutineInvitationStatusQuery } from '../../application/queries/routine-status.query';

@UseGuards(InvitationAuthGuard)
@Controller('api/me/invitations')
export class InvitationNestController {
  constructor(
    private readonly accept: AcceptInvitationCommand,
    private readonly reject: RejectInvitationCommand,
    private readonly status: InvitationStatusQuery,
    private readonly acceptRoutine: AcceptRoutineInvitationCommand,
    private readonly rejectRoutine: RejectRoutineInvitationCommand,
    private readonly routineStatus: RoutineInvitationStatusQuery,
  ) {}

  // ----- 普通录取邀请 -----

  @Get('recruitment/:invitationId')
  async recruitmentStatus(
    @Param('invitationId') invitationId: string,
    @Req() request: Record<string, unknown>,
  ): Promise<ApiSuccess<unknown>> {
    try {
      const view = await this.status.getStatus(invitationId, {
        principalId: this.principal(request),
        roles: [],
        clubId: '',
      });
      return { code: 0, data: view };
    } catch (error) {
      throw this.mapError(error);
    }
  }

  @Post('recruitment/:invitationId/respond')
  async recruitmentRespond(
    @Param('invitationId') invitationId: string,
    @Req() request: Record<string, unknown>,
    @Body() body: unknown,
  ): Promise<ApiSuccess<unknown>> {
    const action = extractAction(body);
    const principalId = this.principal(request);
    try {
      if (action === 'accept') {
        // eligibilityOk：账号有效性在会话建立时已实时核验（CAS-REC-002）；
        // 逐请求新鲜度分级核验随 freshness registry 任务落地（当前会话 JWT ≤24h）。
        const invitation = await this.accept.execute({
          invitationId,
          principalId,
          eligibilityOk: true,
        });
        return { code: 0, data: serializeInvitation(invitation) };
      }
      if (action === 'reject') {
        const invitation = await this.reject.execute({ invitationId, principalId });
        return { code: 0, data: serializeInvitation(invitation) };
      }
      throw new HttpException(
        { code: 'IFC-ERR-005', message: 'action 仅支持 accept|reject' },
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    } catch (error) {
      throw this.mapError(error);
    }
  }

  // ----- 常规入社邀请 -----

  @Get('membership/:invitationId')
  async membershipStatus(
    @Param('invitationId') invitationId: string,
    @Req() _request: Record<string, unknown>,
  ): Promise<ApiSuccess<unknown>> {
    try {
      const view = await this.routineStatus.getStatus(invitationId);
      return { code: 0, data: view };
    } catch (error) {
      throw this.mapError(error);
    }
  }

  @Post('membership/:invitationId/respond')
  async membershipRespond(
    @Param('invitationId') invitationId: string,
    @Req() request: Record<string, unknown>,
    @Body() body: unknown,
  ): Promise<ApiSuccess<unknown>> {
    const action = extractAction(body);
    const principalId = this.principal(request);
    try {
      if (action === 'accept') {
        const invitation = await this.acceptRoutine.execute({
          routineInvitationId: invitationId,
          principalId,
          eligibilityOk: true,
          alreadyMember: false,
        });
        return { code: 0, data: serializeInvitation(invitation) };
      }
      if (action === 'reject') {
        const invitation = await this.rejectRoutine.execute({
          routineInvitationId: invitationId,
          principalId,
        });
        return { code: 0, data: serializeInvitation(invitation) };
      }
      throw new HttpException(
        { code: 'IFC-ERR-005', message: 'action 仅支持 accept|reject' },
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    } catch (error) {
      throw this.mapError(error);
    }
  }

  // ----- 内部 -----

  private principal(request: Record<string, unknown>): string {
    const session = invitationSessionFromRequest(request);
    return session?.subjectId ?? '';
  }

  private mapError(error: unknown): HttpException {
    const code =
      error instanceof AcceptInvitationError ||
      error instanceof RejectInvitationError ||
      error instanceof AcceptRoutineError ||
      error instanceof RoutineRejectError ||
      error instanceof InvitationStatusQueryError
        ? (error.message.split(':')[0] as string)
        : null;
    if (code === 'IFC-ERR-006') {
      return new HttpException({ code, message: '邀请不存在' }, HttpStatus.NOT_FOUND);
    }
    if (code === 'IFC-ERR-003') {
      return new HttpException({ code, message: '当前无权操作' }, HttpStatus.FORBIDDEN);
    }
    if (code === 'IFC-ERR-007' || code === 'IFC-ERR-009') {
      return new HttpException(
        { code, message: '状态不允许或冲突' },
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }
    return new HttpException(
      { code: 'IFC-ERR-500', message: '内部错误' },
      HttpStatus.INTERNAL_SERVER_ERROR,
    );
  }
}

function extractAction(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) return null;
  const input = (body as Record<string, unknown>)['input'];
  if (typeof input === 'object' && input !== null) {
    const action = (input as Record<string, unknown>)['action'];
    return typeof action === 'string' ? action : null;
  }
  const action = (body as Record<string, unknown>)['action'];
  return typeof action === 'string' ? action : null;
}

function serializeInvitation(invitation: {
  invitationId?: string;
  routineInvitationId?: string;
  status: string;
  version?: number;
}): Record<string, unknown> {
  return {
    id: invitation.invitationId ?? invitation.routineInvitationId ?? '',
    status: invitation.status,
    version: 'version' in invitation ? invitation.version : undefined,
  };
}
