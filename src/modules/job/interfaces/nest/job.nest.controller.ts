/**
 * 后台任务管理端点 Nest 适配控制器（interfaces/nest；运维只读 + 受控重试）。
 *
 * 路由（守卫未认证 401；仅接受已认证会话，主体用于审计，fail-closed）：
 * - GET  /api/admin/jobs/status              任务积压/完成情况聚合（真实读取 store）
 * - POST /api/admin/jobs/run-once            立即跑一轮领取执行（手动排空，返回处理数）
 * - POST /api/admin/jobs/:jobId/retry        人工重投某任务（failed/pending → pending）
 *
 * 说明：job 为纯后台执行模块，无业务契约文件；端点严格基于 store/runner 既有
 * 公开能力暴露运维能力，不臆造领域方法。错误统一 toApiError 脱敏输出。
 */

import {
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
import type { AuthSession } from '../../../identity/interfaces/nest/auth-session';
import { JOB_TASK_STORE } from '../../tokens';
import type { JobTaskStore } from '../../job-task.store';
import { JobTaskRunner } from '../../job-task-runner';
import { toApiError } from '../http/job-error-http';

@UseGuards(AuthGuard)
@Controller('api/admin/jobs')
export class JobNestController {
  constructor(
    @Inject(JOB_TASK_STORE) private readonly store: JobTaskStore,
    @Inject(JobTaskRunner) private readonly runner: JobTaskRunner,
  ) {}

  /** 统一执行：领域/存储错误统一脱敏映射为 HTTP 异常 */
  private async run(op: Promise<unknown> | (() => Promise<unknown>)): Promise<ApiSuccess<unknown>> {
    try {
      const value = await (typeof op === 'function' ? op() : op);
      return { code: 0, data: value };
    } catch (error) {
      const mapped = toApiError(error);
      throw new HttpException(mapped.body, mapped.status);
    }
  }

  private session(request: Record<string, unknown>): AuthSession {
    return sessionFromRequest(request);
  }

  /** 任务状态聚合：从共享存储读取真实积压/完成情况，供运维状态页使用 */
  @Get('status')
  async getStatus(@Req() request: Record<string, unknown>): Promise<ApiSuccess<unknown>> {
    const session = this.session(request);
    return this.run(async () => {
      const counts = await this.store.countByStatus();
      return {
        counts,
        runner: { available: true, triggeredBy: session.subjectId },
        generatedAt: new Date().toISOString(),
      };
    });
  }

  /** 立即跑一轮领取+执行（手动排空积压；与 worker 轮询同至少一次语义，安全） */
  @Post('run-once')
  async runOnce(@Req() request: Record<string, unknown>): Promise<ApiSuccess<unknown>> {
    const session = this.session(request);
    return this.run(async () => {
      const processed = await this.runner.runOnce(new Date());
      return { processed, triggeredBy: session.subjectId };
    });
  }

  /** 人工重投：将 failed/pending 任务重置为 pending 立即可被领取（手动重试入口） */
  @Post(':jobId/retry')
  async retryJob(
    @Param('jobId') jobId: string,
    @Req() request: Record<string, unknown>,
  ): Promise<ApiSuccess<unknown>> {
    const session = this.session(request);
    return this.run(async () => {
      const now = new Date();
      await this.store.requeue(jobId, now, now);
      return { jobId, requeued: true, triggeredBy: session.subjectId };
    });
  }
}
