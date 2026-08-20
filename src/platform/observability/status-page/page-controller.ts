/**
 * 超级管理员内置只读状态页端点（observability/README §6.3；ADR-011 §6.3）。
 *
 * 路径：src/platform/observability/status-page/（PR #32 §2.2 B）。
 *
 * 边界：
 * - 仅当前有效超管可访问（StatusPageAuthorizer 守卫）；
 * - 只读：不接受任何 POST/PUT/DELETE；不调用任何写命令、触发任务重试或外部
 *   写入（ADR-011 §2.1 第 1/3 条）；
 * - 不读取业务数据；不向页面写入任何持久化事实（页面仅是查询视图）。
 *
 * 当前阶段：
 * - `actor` 字段来源待 NestJS Request context 接入；本 MR 的 Controller 接受
 *   undefined actor 并交由 authorizer.assertSuperAdmin() 统一处理；
 * - authorizer 默认绑定 RejectAllStatusPageAuthorizer——身份模块接入前页面
 *   总是 403，身份模块接入后切换为 IdentityStatusPageAuthorizer。
 */

import { Controller, Get, HttpCode, Inject } from '@nestjs/common';

import { STATUS_PAGE_AUTHORIZER, STATUS_SUMMARY_QUERY } from './tokens';
import { type StatusPageActor, type StatusPageAuthorizer } from './status-page-authorizer';
import {
  type StatusSummaryQueryService,
  type StatusSummaryView,
} from './status-summary-query.service';

@Controller('admin/status')
export class StatusPageController {
  constructor(
    @Inject(STATUS_SUMMARY_QUERY)
    private readonly query: StatusSummaryQueryService,
    @Inject(STATUS_PAGE_AUTHORIZER)
    private readonly authorizer: StatusPageAuthorizer,
  ) {}

  @Get()
  @HttpCode(200)
  async getStatus(actor?: StatusPageActor): Promise<StatusSummaryView> {
    this.authorizer.assertSuperAdmin(actor);
    return this.query.execute(new Date());
  }
}
