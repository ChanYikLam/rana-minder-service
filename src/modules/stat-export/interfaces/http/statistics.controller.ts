/**
 * 统计 HTTP 控制器（StatisticsController，STAT-002）。
 *
 * 路由事实基线：docs/specification/接口清单-HTTP端点-v1.0.md §14.2/§15.8。
 *
 * 汇总/下钻分离：summary 返回缩略指标（含趋势、部门分布、口径声明）；
 * drilldown 返回记录级明细（记录级权限校验继续执行，STAT-003）。
 *
 * 错误映射：应用层错误（StatisticsAccessError/StatisticsCaliberError）
 * → IFC-ERR-* → HTTP 状态，带 supportId。
 */

import { Controller, Get, Inject, Param, Query } from '@nestjs/common';
import { HttpException } from '@nestjs/common';

import { StatisticsActor, type RequestActor } from './statistics-actor';
import { StatisticsSpecification } from '../../domain/models/statistics-specification';
import {
  ClubStatisticsQuery,
  type ClubStatisticsInput,
} from '../../application/queries/club-statistics.query';
import { RecruitmentFunnelQuery } from '../../application/queries/recruitment-funnel.query';
import { JointActivityStatisticsQuery } from '../../application/queries/joint-activity-statistics.query';
import {
  STATISTICS_AUTHORIZATION_PORT,
  type StatisticsAuthorizationPort,
} from '../../application/ports/statistics-authorization.port';
import { StatisticsAccessError } from '../../application/statistics-errors';
import { StatisticsCaliberError } from '../../domain/models/statistics-specification';
import { IFC_ERROR_HTTP_STATUS } from '../../../../common/contracts/api-error';
import { generateTraceId } from '../../../../platform/observability/domain/services/trace-id.generator';

@Controller('api')
export class StatisticsController {
  constructor(
    @Inject(STATISTICS_AUTHORIZATION_PORT)
    private readonly authz: StatisticsAuthorizationPort,
    private readonly clubStats: ClubStatisticsQuery,
    private readonly funnel: RecruitmentFunnelQuery,
    private readonly jointStats: JointActivityStatisticsQuery,
    private readonly spec: StatisticsSpecification,
  ) {}

  // -----------------------------------------------------------------------
  // GET /api/org/:clubId/stats —— 社团统计摘要
  // -----------------------------------------------------------------------

  @Get('org/:clubId/stats')
  async clubSummary(
    @StatisticsActor() actor: RequestActor,
    @Param('clubId') clubId: string,
    @Query('academicYear') academicYear?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.catchErrors(async () => {
      const principal = await this.authz.resolvePrincipal(actor.userId);
      const input: ClubStatisticsInput = {
        principal,
        clubId,
        filters: this.parseFilters({ academicYear, from, to }),
      };
      return this.clubStats.summary(input);
    });
  }

  // -----------------------------------------------------------------------
  // GET /api/org/:clubId/stats/drilldown —— 社团统计下钻（记录级）
  // -----------------------------------------------------------------------

  @Get('org/:clubId/stats/drilldown')
  async clubDrillDown(
    @StatisticsActor() actor: RequestActor,
    @Param('clubId') clubId: string,
    @Query('metric') metric?: string,
    @Query('departmentId') departmentId?: string,
    @Query('academicYear') academicYear?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('limit') limitRaw?: string,
  ) {
    return this.catchErrors(async () => {
      if (!metric)
        throw new StatisticsAccessError(
          'IFC-ERR-005',
          '缺少必填查询参数 metric（支持：current_members, admission_history）',
        );
      this.spec.assertLeaderboardClosed(metric);

      const principal = await this.authz.resolvePrincipal(actor.userId);
      const limit = limitRaw ? parseInt(limitRaw, 10) : undefined;
      if (limit !== undefined && (Number.isNaN(limit) || limit < 1)) {
        throw new StatisticsAccessError('IFC-ERR-005', 'limit 必须为正整数');
      }
      return this.clubStats.drilldown({
        principal,
        clubId,
        metric,
        limit,
        filters: this.parseFilters({ academicYear, departmentId, from, to }),
      });
    });
  }

  // -----------------------------------------------------------------------
  // GET /api/org/:clubId/stats/recruitment-funnel/:activityId —— 招新漏斗
  // -----------------------------------------------------------------------

  @Get('org/:clubId/stats/recruitment-funnel/:activityId')
  async recruitmentFunnel(
    @StatisticsActor() actor: RequestActor,
    @Param('clubId') clubId: string,
    @Param('activityId') activityId: string,
    @Query('departmentId') departmentId?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.catchErrors(async () => {
      const principal = await this.authz.resolvePrincipal(actor.userId);
      return this.funnel.funnel({
        principal,
        clubId,
        activityId,
        filters: this.parseFilters({ departmentId, from, to }),
      });
    });
  }

  // -----------------------------------------------------------------------
  // GET /api/org/:clubId/stats/joint/:jointId —— 联合活动统计
  // -----------------------------------------------------------------------

  @Get('org/:clubId/stats/joint/:jointId')
  async jointActivityStats(
    @StatisticsActor() actor: RequestActor,
    @Param('clubId') clubId: string, // URL 作用域提示；查询用 jointId 加载，再验证 scope
    @Param('jointId') jointId: string,
  ) {
    return this.catchErrors(async () => {
      const principal = await this.authz.resolvePrincipal(actor.userId);
      return this.jointStats.statistics({
        principal,
        jointActivityId: jointId,
      });
    });
  }

  // -----------------------------------------------------------------------
  // GET /api/admin/stats —— 全平台统计（超管）
  // -----------------------------------------------------------------------

  @Get('admin/stats')
  async platformSummary(@StatisticsActor() actor: RequestActor) {
    return this.catchErrors(async () => {
      const principal = await this.authz.resolvePrincipal(actor.userId);
      return this.clubStats.platformSummary(principal);
    });
  }

  // -----------------------------------------------------------------------
  // 内部：错误映射
  // -----------------------------------------------------------------------

  private async catchErrors<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof StatisticsAccessError) {
        const supportId = generateTraceId();
        throw new HttpException(
          { code: err.code, message: err.message, supportId },
          err.httpStatus,
        );
      }
      if (err instanceof StatisticsCaliberError) {
        const supportId = generateTraceId();
        throw new HttpException(
          { code: 'IFC-ERR-005' as const, message: err.message, supportId },
          IFC_ERROR_HTTP_STATUS['IFC-ERR-005'],
        );
      }
      // 兜底：500
      const supportId = generateTraceId();
      throw new HttpException(
        { code: 'IFC-ERR-016' as const, message: '服务异常，请稍后重试', supportId },
        500,
      );
    }
  }

  // -----------------------------------------------------------------------
  // 内部：查询参数解析
  // -----------------------------------------------------------------------

  private parseFilters(q: {
    academicYear?: string;
    departmentId?: string;
    from?: string;
    to?: string;
  }) {
    const filters: {
      academicYear?: string;
      departmentId?: string;
      timeRange?: { from: string; to: string };
    } = {};
    if (q.academicYear) filters.academicYear = q.academicYear;
    if (q.departmentId) filters.departmentId = q.departmentId;
    if (q.from && q.to) filters.timeRange = { from: q.from, to: q.to };
    return Object.keys(filters).length > 0 ? filters : undefined;
  }
}

export { IFC_ERROR_HTTP_STATUS as STATS_IFC_STATUS_MAP };
