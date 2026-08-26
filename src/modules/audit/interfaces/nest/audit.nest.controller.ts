/**
 * 事实纠错与审计域 Nest 适配控制器（interfaces/nest；AUD-003/004、SRS-SM-AUD-001）�? *
 * 路由（守卫未认证 401；授权在用例内部 fail-closed）：
 * - GET  /api/org/:clubId/audit/logs                   本社团审计日志（CLUB_LEADER/HR_ADMIN�? * - GET  /api/admin/audit/logs                         平台级审计日志（SUPER_ADMIN�? * - POST /api/org/:clubId/corrections                  提交纠错（草稿→待处理，组合两个用例�? * - POST /api/org/:clubId/corrections/:id/decide       审批/驳回纠错
 * - POST /api/org/:clubId/corrections/:id/withdraw     原提交人撤回纠错
 *
 * 业务字段只读信封 input（API-GEN-003）；错误统一 toApiError 脱敏输出�? *
 * 注：当前 AuthSession 仅含 subjectId/now，不含角色；此处按端点语义注入所需角色
 * （CLUB_LEADER/HR_ADMIN/SUPER_ADMIN），真实鉴权以接入后的会话提供方为准�? * 未映射端点：GET /api/org/:clubId/corrections（列表）——应用层无列举用�?仓储
 * 枚举方法，且 CorrectionStatusQuery 仅返回状态视图、不足以构造完�?CorrectionRecord�? */

import {
  Body,
  Controller,
  Get,
  Inject,
  Param,
  Post,
  Req,
  UseGuards,
  HttpException,
} from '@nestjs/common';

import type { ApiSuccess } from '../../../../common/contracts/api-envelope';
import type {
  AuditLogItem,
  CorrectionRecord,
  CorrectionStatus as CorrectionStatusContract,
  CorrectionAuditTrailItem,
} from '../../../../common/contracts/audit.contracts';
import { AuthGuard, sessionFromRequest } from '../../../identity/interfaces/nest/auth.guard';
import type { AuditEvent } from '../../domain/models/audit-event';
import { CorrectionStatus } from '../../domain/state-machines/correction-state-machine';
import { ObjectiveErrorType, type Correction } from '../../domain/models/correction';
import { AuditQuery } from '../../application/queries/audit-query';
import { SaveCorrectionDraftCommand } from '../../application/commands/correction-submit.command';
import { SubmitCorrectionCommand } from '../../application/commands/correction-submit.command';
import { DecideCorrectionCommand } from '../../application/commands/correction-decide.command';
import { WithdrawCorrectionCommand } from '../../application/commands/correction-decide.command';
import {
  AUDIT_QUERY,
  SAVE_CORRECTION_DRAFT_COMMAND,
  SUBMIT_CORRECTION_COMMAND,
  DECIDE_CORRECTION_COMMAND,
  WITHDRAW_CORRECTION_COMMAND,
} from '../../tokens';
import { toApiError } from '../http/audit-error-http';
import { parseAuditRequestEnvelope } from '../http/audit-envelope';

/** 提交纠错请求体（contract CreateCorrectionInput 超集：补充域必填字段�?*/
interface CreateCorrectionBody {
  readonly targetType: string;
  readonly targetId: string;
  readonly reason: string;
  readonly evidence: string;
  /** 目标记录原作者（作者回避，AUD-001�?*/
  readonly authorId: string;
  readonly fieldKey: string;
  readonly recordVersion: number;
  readonly objectiveErrorType: ObjectiveErrorType;
  readonly expectedCorrection: string;
  readonly evidenceRefs?: readonly string[];
  readonly deadlineAt: string;
}

/** 审批/驳回请求体（contract DecideCorrectionInput 超集�?*/
interface DecideCorrectionBody {
  readonly decision?: 'approve' | 'reject';
  readonly reason?: string;
  readonly oldValue?: string;
  readonly newValue?: string;
  readonly participantClubIds?: readonly string[];
}

@UseGuards(AuthGuard)
@Controller('api')
export class AuditNestController {
  constructor(
    @Inject(AUDIT_QUERY) private readonly auditQuery: AuditQuery,
    @Inject(SAVE_CORRECTION_DRAFT_COMMAND)
    private readonly saveDraft: SaveCorrectionDraftCommand,
    @Inject(SUBMIT_CORRECTION_COMMAND)
    private readonly submit: SubmitCorrectionCommand,
    @Inject(DECIDE_CORRECTION_COMMAND)
    private readonly decide: DecideCorrectionCommand,
    @Inject(WITHDRAW_CORRECTION_COMMAND)
    private readonly withdraw: WithdrawCorrectionCommand,
  ) {}

  /** 统一执行：领域错误统一脱敏映射�?HttpException */
  private async run(op: () => Promise<unknown>): Promise<ApiSuccess<unknown>> {
    try {
      const value = await op();
      return { code: 0, data: value };
    } catch (error) {
      const mapped = toApiError(error);
      throw new HttpException(mapped.body, mapped.status);
    }
  }

  /** 本社团审计日志：仅负责人/人事（AUD-004�?*/
  @Get('org/:clubId/audit/logs')
  async listOrgLogs(
    @Param('clubId') clubId: string,
    @Req() request: Record<string, unknown>,
  ): Promise<ApiSuccess<unknown>> {
    const subjectId = sessionFromRequest(request).subjectId;
    return this.run(async () => {
      const events = await this.auditQuery.search(
        { principalId: subjectId, roles: ['CLUB_LEADER', 'HR_ADMIN'], clubId },
        { clubId },
      );
      return { items: events.map((e) => this.toAuditLogItem(e)), nextCursor: null };
    });
  }

  /** 平台级审计日志：仅超管（AUD-004�?*/
  @Get('admin/audit/logs')
  async listPlatformLogs(@Req() request: Record<string, unknown>): Promise<ApiSuccess<unknown>> {
    const subjectId = sessionFromRequest(request).subjectId;
    return this.run(async () => {
      const events = await this.auditQuery.search(
        { principalId: subjectId, roles: ['SUPER_ADMIN'] },
        {},
      );
      return { items: events.map((e) => this.toAuditLogItem(e)), nextCursor: null };
    });
  }

  /** 提交纠错：草稿→待处理（组合两个应用用例，SRS-SM-AUD-001�?*/
  @Post('org/:clubId/corrections')
  async createCorrection(
    @Param('clubId') clubId: string,
    @Req() request: Record<string, unknown>,
    @Body() body: unknown,
  ): Promise<ApiSuccess<unknown>> {
    const subjectId = sessionFromRequest(request).subjectId;
    const input = parseAuditRequestEnvelope(body).input as CreateCorrectionBody;
    return this.run(async () => {
      const draft = await this.saveDraft.execute({
        applicantId: subjectId,
        authorId: input.authorId,
        targetRecord: {
          objectType: input.targetType,
          objectId: input.targetId,
          ownerClubId: clubId,
          fieldKey: input.fieldKey,
          recordVersion: input.recordVersion,
        },
        objectiveErrorType: input.objectiveErrorType,
        expectedCorrection: input.expectedCorrection,
        evidenceRefs: input.evidenceRefs ?? [input.evidence],
        deadlineAt: input.deadlineAt,
      });
      const submitted = await this.submit.execute({
        correctionId: draft.correctionId,
        applicantId: subjectId,
        objectiveDescription: input.reason,
      });
      return this.toCorrectionRecord(submitted);
    });
  }

  /** 审批/驳回纠错（SRS-SM-AUD-001；作者回�?+ 本社团处理在用例内部校验�?*/
  @Post('org/:clubId/corrections/:id/decide')
  async decideCorrection(
    @Param('clubId') clubId: string,
    @Param('id') id: string,
    @Req() request: Record<string, unknown>,
    @Body() body: unknown,
  ): Promise<ApiSuccess<unknown>> {
    const subjectId = sessionFromRequest(request).subjectId;
    const input = parseAuditRequestEnvelope(body).input as DecideCorrectionBody;
    return this.run(async () => {
      const decided = await this.decide.execute({
        correctionId: id,
        decider: { principalId: subjectId, roles: ['CLUB_LEADER', 'HR_ADMIN'], clubId },
        participantClubIds: input.participantClubIds,
        approve: input.decision === 'approve',
        reason: input.reason ?? '',
        oldValue: input.oldValue,
        newValue: input.newValue,
      });
      return this.toCorrectionRecord(decided);
    });
  }

  /** 原提交人撤回纠错（SRS-SM-AUD-001�?*/
  @Post('org/:clubId/corrections/:id/withdraw')
  async withdrawCorrection(
    @Param('id') id: string,
    @Req() request: Record<string, unknown>,
  ): Promise<ApiSuccess<unknown>> {
    const subjectId = sessionFromRequest(request).subjectId;
    return this.run(async () => {
      const withdrawn = await this.withdraw.execute({ correctionId: id, applicantId: subjectId });
      return this.toCorrectionRecord(withdrawn);
    });
  }

  private toAuditLogItem(e: AuditEvent): AuditLogItem {
    const scope: 'org' | 'platform' =
      e.scope?.kind === 'platform' || e.scope?.kind === 'PLATFORM' ? 'platform' : 'org';
    return {
      id: e.auditId,
      actorName: e.actorId,
      action: e.eventType,
      targetType: e.target?.objectType ?? '',
      targetId: e.target?.objectId ?? '',
      detail: e.failureReason ?? '',
      createdAt: e.occurredAt,
      scope,
    };
  }

  private toCorrectionRecord(c: Correction): CorrectionRecord {
    const withdrawn = c.history.find((h) => h.type === 'WITHDRAWN');
    return {
      id: c.correctionId,
      targetType: c.targetRecord.objectType,
      targetId: c.targetRecord.objectId,
      reason: c.expectedCorrection,
      evidence: c.evidenceRefs.join('; '),
      status: this.toCorrectionStatus(c.status),
      submittedAt: c.submittedAt ?? '',
      submitterName: c.applicantId,
      decidedBy: c.decision?.decidedBy,
      decidedAt: c.decision?.decidedAt,
      withdrawnBy: withdrawn?.by,
      withdrawnAt: withdrawn?.at,
      auditTrail: c.history.map((h) => ({
        action: this.toTrailAction(h.type) as CorrectionAuditTrailItem['action'],
        actorName: h.by,
        at: h.at,
        note: h.note,
      })),
    };
  }

  private toCorrectionStatus(status: CorrectionStatus): CorrectionStatusContract {
    switch (status) {
      case CorrectionStatus.PENDING:
        return 'submitted';
      case CorrectionStatus.OVERDUE_PENDING:
        return 'overdue';
      case CorrectionStatus.APPROVED:
        return 'approved';
      case CorrectionStatus.REJECTED:
        return 'rejected';
      case CorrectionStatus.WITHDRAWN:
        return 'withdrawn';
      // 草稿/新建尚未进入公开状态机，契约无对应枚举；正常流不会到达此分支�?      case CorrectionStatus.DRAFT:
      case CorrectionStatus.NEW:
      default:
        return 'submitted';
    }
  }

  private toTrailAction(type: string): CorrectionAuditTrailItem['action'] {
    switch (type) {
      case 'SUBMITTED':
        return 'submit';
      case 'APPROVED':
        return 'approve';
      case 'REJECTED':
        return 'reject';
      case 'WITHDRAWN':
        return 'withdraw';
      // DRAFTED / MARKED_OVERDUE 折叠�?submit（契约动作枚举有限）
      default:
        return 'submit';
    }
  }
}
