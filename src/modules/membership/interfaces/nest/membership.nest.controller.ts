/**
 * 成员生命周期域 Nest 适配控制器（interfaces/nest；工作包① P0 仅传输层）。
 *
 * 路由（守卫未认证 401；权限在命令内部 fail-closed）：
 * 基址 /api/org/:clubId/members
 * - POST   department-apply                      提交部门关系申请（A1）
 * - POST   department-apply/:id/decide           审批部门关系申请（A3/A4）
 * - POST   department-apply/:id/execute          执行已批准申请（A5~A8）
 * - POST   department-apply/:id/withdraw         撤回部门关系申请（A2）
 * - GET    :memberId                             成员详情（经历＋当前关系，组合查询）
 *
 * 说明：本控制器只暴露“已有应用层用例/查询”且不依赖凭空捏造的解析器。
 * 其余端点（成员列表/stats、任命、辞职提交与审批、移除、邀请、换届、受控批量
 * 等）因底层缺少对应用例或需要 periodId/relationSnapshot 聚合解析，未在应用层
 * 暴露，本次不予实现，详见交付报告“无法映射项”。
 *
 * 认证复用 identity 的 AuthGuard / sessionFromRequest（禁止自造守卫）。
 * 成功统一返回 { code: 0, data }；领域错误经 toApiError 脱敏为 HttpException。
 */

import {
  Body,
  Controller,
  Get,
  HttpException,
  Inject,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';

import type { ApiSuccess } from '../../../../common/contracts/api-envelope';
import { AuthGuard, sessionFromRequest } from '../../../identity/interfaces/nest/auth.guard';
import { toApiError } from '../http/membership-error-http';

import {
  SUBMIT_DEPARTMENT_APPLICATION_COMMAND,
  DECIDE_DEPARTMENT_APPLICATION_COMMAND,
  EXECUTE_DEPARTMENT_APPLICATION_COMMAND,
  WITHDRAW_DEPARTMENT_APPLICATION_COMMAND,
  MEMBER_EXPERIENCE_QUERY,
  DEPARTMENT_RELATION_QUERY,
} from '../../tokens';

import type { SubmitDepartmentApplicationCommand } from '../../application/commands/submit-department-application.command';
import type { DecideDepartmentApplicationCommand } from '../../application/commands/decide-department-application.command';
import type { ExecuteDepartmentApplicationCommand } from '../../application/commands/execute-department-application.command';
import type { WithdrawDepartmentApplicationCommand } from '../../application/commands/withdraw-department-application.command';
import type { MemberExperienceQuery } from '../../application/queries/member-experience.query';
import type { DepartmentRelationQuery } from '../../application/queries/department-relation.query';

import type {
  CreateDepartmentApplyInput,
  DecideDepartmentApplyInput,
} from '../../../../common/contracts/members.contracts';

/** 端点入参契约类型（防止依赖误用；值由请求体解析） */
type RawBody = Record<string, unknown> | undefined;

/** 信封解析：兼容 { input } 信封与平铺写法 */
function envelopeInput<T>(body: RawBody): T {
  if (body !== undefined && typeof body === 'object' && 'input' in body) {
    return (body as { input: T }).input;
  }
  return body as T;
}

/** 部门关系申请类型：契约 lower → 命令 upper */
function mapApplyType(type: string): 'JOIN' | 'LEAVE' | 'TRANSFER' {
  switch (type) {
    case 'join':
      return 'JOIN';
    case 'leave':
      return 'LEAVE';
    case 'transfer':
      return 'TRANSFER';
    default:
      throw new Error(`IFC-ERR-006: 不支持的部门关系申请类型 ${type}`);
  }
}

@UseGuards(AuthGuard)
@Controller('api/org/:clubId/members')
export class MembershipNestController {
  constructor(
    @Inject(SUBMIT_DEPARTMENT_APPLICATION_COMMAND)
    private readonly submitApplication: SubmitDepartmentApplicationCommand,
    @Inject(DECIDE_DEPARTMENT_APPLICATION_COMMAND)
    private readonly decideApplication: DecideDepartmentApplicationCommand,
    @Inject(EXECUTE_DEPARTMENT_APPLICATION_COMMAND)
    private readonly executeApplication: ExecuteDepartmentApplicationCommand,
    @Inject(WITHDRAW_DEPARTMENT_APPLICATION_COMMAND)
    private readonly withdrawApplication: WithdrawDepartmentApplicationCommand,
    @Inject(MEMBER_EXPERIENCE_QUERY)
    private readonly experienceQuery: MemberExperienceQuery,
    @Inject(DEPARTMENT_RELATION_QUERY)
    private readonly relationQuery: DepartmentRelationQuery,
  ) {}

  /** 统一执行：领域错误统一脱敏映射为 HttpException */
  private async run(op: Promise<unknown> | (() => Promise<unknown>)): Promise<ApiSuccess<unknown>> {
    try {
      const value = await (typeof op === 'function' ? op() : op);
      return { code: 0, data: value };
    } catch (error) {
      const mapped = toApiError(error);
      throw new HttpException(mapped.body, mapped.status);
    }
  }

  /** 提交部门关系申请（A1）：本人发起，目标/范围/原因来自请求体 */
  @Post('department-apply')
  async submitDepartmentApply(
    @Param('clubId') clubId: string,
    @Req() request: Record<string, unknown>,
    @Body() body: RawBody,
  ): Promise<ApiSuccess<unknown>> {
    const subjectId = sessionFromRequest(request).subjectId;
    const input = envelopeInput<CreateDepartmentApplyInput & { leaveDeptIds?: string[] }>(body);
    return this.run(
      this.submitApplication.execute({
        clubId,
        applicantId: subjectId,
        type: mapApplyType(input.type),
        targetDeptId: input.targetDeptId,
        leaveDeptIds: input.leaveDeptIds,
        reason: input.reason,
      }),
    );
  }

  /** 审批部门关系申请（A3/A4）：合格审批人批准或驳回 */
  @Post('department-apply/:id/decide')
  async decideDepartmentApply(
    @Param('id') id: string,
    @Req() request: Record<string, unknown>,
    @Body() body: RawBody,
  ): Promise<ApiSuccess<unknown>> {
    const operatorId = sessionFromRequest(request).subjectId;
    const input = envelopeInput<DecideDepartmentApplyInput>(body);
    return this.run(
      this.decideApplication.execute({
        applicationId: id,
        operatorId,
        decision: input.decision === 'approve' ? 'APPROVE' : 'REJECT',
        rejectReason: input.rejectReason,
      }),
    );
  }

  /** 执行已批准申请（A5~A8）：启动写入＋回读结算，失败保持处理中 */
  @Post('department-apply/:id/execute')
  async executeDepartmentApply(
    @Param('id') id: string,
    @Req() request: Record<string, unknown>,
  ): Promise<ApiSuccess<unknown>> {
    const operatorId = sessionFromRequest(request).subjectId;
    return this.run(this.executeApplication.execute(id, operatorId));
  }

  /** 撤回部门关系申请（A2）：仅申请人本人、待审批、二次确认 */
  @Post('department-apply/:id/withdraw')
  async withdrawDepartmentApply(
    @Param('id') id: string,
    @Req() request: Record<string, unknown>,
    @Body() body: RawBody,
  ): Promise<ApiSuccess<unknown>> {
    const operatorId = sessionFromRequest(request).subjectId;
    const input = envelopeInput<{ secondConfirmed?: boolean }>(body);
    return this.run(
      this.withdrawApplication.execute({
        applicationId: id,
        operatorId,
        secondConfirmed: input?.secondConfirmed ?? true,
      }),
    );
  }

  /** 成员详情：组合成员经历查询与当前部门/职位关系查询（应用层已有查询） */
  @Get(':memberId')
  async getMemberDetail(
    @Param('clubId') clubId: string,
    @Param('memberId') memberId: string,
  ): Promise<ApiSuccess<unknown>> {
    return this.run(async () => {
      const period = await this.experienceQuery.currentPeriod(clubId, memberId);
      const relations = await this.relationQuery.listCurrentValid(clubId, memberId);
      return { period, relations };
    });
  }
}
