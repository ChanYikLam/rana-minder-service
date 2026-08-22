import { Inject, Injectable, Logger } from '@nestjs/common';
import { RANA_MINDER_CONFIG, type RanaMinderConfig } from '../../../config';
import {
  TaskStatus,
  TASK_PROCESSOR_REGISTRY,
  TASK_REPOSITORY,
  TaskExecutionError,
} from '../contracts';
import type { TaskProcessorRegistry, TaskRecord, TaskRepository } from '../contracts';
import { RecoveryReplayConvergence } from '../idempotency';
import { LeaseManager } from '../lease';
import {
  classifyFailure,
  computeExponentialBackoffMs,
  requiresManualIntervention,
} from '../retry-policy';
import { TASK_PRECONDITION_PORT, type TaskPreconditionPort } from './task-precondition';

@Injectable()
export class TaskExecutionPipeline {
  private readonly logger = new Logger(TaskExecutionPipeline.name);

  constructor(
    @Inject(TASK_REPOSITORY) private readonly repository: TaskRepository,
    private readonly leases: LeaseManager,
    private readonly convergence: RecoveryReplayConvergence,
    @Inject(TASK_PROCESSOR_REGISTRY)
    private readonly processors: TaskProcessorRegistry,
    @Inject(TASK_PRECONDITION_PORT)
    private readonly precondition: TaskPreconditionPort,
    @Inject(RANA_MINDER_CONFIG)
    private readonly config: RanaMinderConfig,
  ) {}

  async execute(taskId: string, workerId: string, now: Date): Promise<void> {
    const task = await this.repository.findById(taskId);
    if (task === null) return;
    if (task.status === TaskStatus.COMPLETED) return;

    const claim = await this.leases.tryClaim(taskId, workerId, this.config.job.defaultLeaseMs, now);
    if (claim.claimed === false || claim.task === null) return;

    const leased = claim.task;
    const attempt = leased.attempts + 1;

    const convergence = await this.convergence.convergeBeforeExecution(leased, now);
    if (convergence.allowed === false) {
      await this.finishAfterConvergence(leased, now, attempt, convergence.resultRef);
      return;
    }

    const check = await this.precondition.verify(leased);
    if (check.ok === false) {
      await this.releaseWithPatch(leased, now, {
        status: TaskStatus.MANUAL_INTERVENTION,
        attempts: attempt,
        failure: {
          kind: 'PRECONDITION_REJECTED',
          reason: check.reason ?? 'precondition rejected',
          occurredAt: now.toISOString(),
        },
      });
      return;
    }

    const handler = this.processors.get(leased.taskType);
    if (handler === undefined) {
      await this.releaseWithPatch(leased, now, {
        status: TaskStatus.MANUAL_INTERVENTION,
        attempts: attempt,
        failure: {
          kind: 'MANUAL_INTERVENTION_REQUIRED',
          reason: `未注册的任务处理器：${leased.taskType}`,
          occurredAt: now.toISOString(),
        },
      });
      return;
    }

    try {
      await handler.handle(leased, now);
      const resultRef = `task:${leased.taskId}:completed:${now.toISOString()}`;
      await this.convergence.convergeAfterSuccess(leased, resultRef);
      await this.releaseWithPatch(leased, now, {
        status: TaskStatus.COMPLETED,
        attempts: attempt,
        resultRef,
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      await this.convergence.convergeAfterFailure(leased);

      // 处理器明确声明不可重试（如 MANUAL_INTERVENTION_REQUIRED / THIRD_VALUE /
      // payload 不完整）：立即人工处置，不耗尽重试次数。
      if (err instanceof TaskExecutionError && err.retryable === false) {
        await this.releaseWithPatch(leased, now, {
          status: TaskStatus.MANUAL_INTERVENTION,
          attempts: attempt,
          failure: {
            kind: err.failureKind,
            reason,
            occurredAt: now.toISOString(),
          },
        });
        return;
      }

      if (requiresManualIntervention(attempt, leased.maxAttempts) === false) {
        const backoffMs = computeExponentialBackoffMs(attempt, 1000, 60_000);
        await this.releaseWithPatch(leased, now, {
          status: TaskStatus.RETRYABLE_FAILED,
          attempts: attempt,
          failure: {
            kind: err instanceof TaskExecutionError ? err.failureKind : classifyFailure(reason),
            reason,
            occurredAt: now.toISOString(),
          },
          notBefore: new Date(now.getTime() + backoffMs).toISOString(),
        });
      } else {
        await this.releaseWithPatch(leased, now, {
          status: TaskStatus.MANUAL_INTERVENTION,
          attempts: attempt,
          failure: {
            kind: 'RETRY_LIMIT_EXCEEDED',
            reason,
            occurredAt: now.toISOString(),
          },
        });
      }
    }
  }

  private async finishAfterConvergence(
    task: TaskRecord,
    now: Date,
    attempt: number,
    resultRef?: string,
  ): Promise<void> {
    if (resultRef !== undefined) {
      // 通过幂等记录收敛为已完成：与正常成功路径保持一致，累加尝试次数
      await this.releaseWithPatch(task, now, {
        status: TaskStatus.COMPLETED,
        attempts: attempt,
        resultRef,
      });
      return;
    }
    // 幂等记录为执行中但本次领取租约后仍未过期（另一 worker 正在执行）：
    // 主动释放本次租约并回写 PENDING，避免任务卡在 LEASED 等待自然过期，形成重复执行窗口。
    this.logger.warn(
      `幂等收敛未放行（执行中且租约有效），释放租约回写 PENDING：taskId=${task.taskId}, idempotencyKey=${task.idempotencyKey}`,
    );
    await this.releaseWithPatch(task, now, {
      status: TaskStatus.PENDING,
      attempts: task.attempts,
    });
  }

  private async releaseWithPatch(
    task: TaskRecord,
    now: Date,
    patch: Parameters<LeaseManager['release']>[1],
  ): Promise<void> {
    const updated = await this.leases.release(
      task,
      { ...patch, updatedAt: now.toISOString() },
      now,
    );
    if (updated === null) {
      this.logger.warn(
        `任务状态更新未生效（租约版本冲突）：taskId=${task.taskId}, expectedLeaseVersion=${task.lease?.leaseVersion ?? 0}`,
      );
    }
  }
}
