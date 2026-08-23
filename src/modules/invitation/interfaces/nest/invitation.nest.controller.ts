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
  Inject,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { ApiSuccess } from '../../../../common/contracts/api-envelope';
import { InvitationAuthGuard, invitationSessionFromRequest } from './invitation-auth.guard';
import { InvitationUniqueViolationError } from '../../infrastructure/postgres-invitation.repository';
import { CASDOOR_USER_PORT } from '../../../identity/tokens';
import type { CasdoorUserPort } from '../../../identity/application/ports/casdoor-user.port';

import { AcceptInvitationCommand } from '../../application/commands/accept-invitation.command';
import { RejectInvitationCommand } from '../../application/commands/reject-invitation.command';
import { AcceptInvitationError } from '../../application/commands/accept-invitation.command';
import { RejectInvitationError } from '../../application/commands/reject-invitation.command';
import {
  InvitationStatusQuery,
  InvitationStatusQueryError,
} from '../../application/queries/invitation-status.query';
import { RoutineInvitationStatusQueryError } from '../../application/queries/routine-status.query';
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
    @Inject(CASDOOR_USER_PORT) private readonly casdoorUser: CasdoorUserPort,
  ) {}

  // ----- 普通录取邀请 -----

  @Get('recruitment/:invitationId')
  async recruitmentStatus(
    @Param('invitationId') invitationId: string,
    @Req() request: Record<string, unknown>,
  ): Promise<ApiSuccess<unknown>> {
    try {
      // 授权在查询内按邀请所属社团解析（GOV-007 权限化），caller 只需提供主体 ID。
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
        // eligibilityOk：接受是 CAS-REC-002 高价值业务动作，逐请求实时复核账号有效性
        // （评审 SEC：会话 JWT 有效 ≤24h，登录后被禁用/删除仍可接受邀请）。
        await this.assertAccountActive(principalId);
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
    @Req() request: Record<string, unknown>,
  ): Promise<ApiSuccess<unknown>> {
    try {
      // 访问控制：仅本人或发文社团负责人/人事可查看（IFC-ERR-003），
      // 授权在查询内按邀请所属社团解析，caller 只需提供主体 ID。
      const view = await this.routineStatus.getStatus(invitationId, {
        principalId: this.principal(request),
        roles: [],
        clubId: '',
      });
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
        // 接受同样逐请求实时复核账号有效性（CAS-REC-002，防会话有效期内被禁用/删除）。
        await this.assertAccountActive(principalId);
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

  /**
   * 接受邀请前的账号有效性实时复核（CAS-REC-002 逐请求新鲜度）。
   * 经 CASDOOR_USER_PORT 可信读取当前账号状态；DISABLED/DELETED 直接拒绝（403），
   * 无法确认（失败/不确定）按 fail-closed 拒绝，不宣称账号当前有效。
   */
  private async assertAccountActive(subjectId: string): Promise<void> {
    if (!subjectId) {
      throw new HttpException(
        { code: 'IFC-ERR-001', message: '未认证或认证失效' },
        HttpStatus.UNAUTHORIZED,
      );
    }
    const result = await this.casdoorUser.readAccountStatus(subjectId);
    const active =
      result.status === 'SUCCESS' && result.data !== null && result.data.state === 'ACTIVE';
    if (!active) {
      throw new HttpException(
        { code: 'IFC-ERR-011', message: '账号已被禁用或删除，无法接受邀请' },
        HttpStatus.FORBIDDEN,
      );
    }
  }

  private mapError(error: unknown): HttpException {
    // 已是 HttpException（如账号有效性实时复核抛出的 401/403）原样透传，不再映射。
    if (error instanceof HttpException) {
      return error;
    }
    // 错误类显式暴露 code 字段（评审 CQ：不再依赖 message.split(':') 解析错误码，
    // 避免解析失败静默降级为 500）。
    const code =
      error instanceof AcceptInvitationError ||
      error instanceof RejectInvitationError ||
      error instanceof AcceptRoutineError ||
      error instanceof RoutineRejectError ||
      error instanceof InvitationStatusQueryError ||
      error instanceof RoutineInvitationStatusQueryError ||
      error instanceof InvitationUniqueViolationError
        ? error.code
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
