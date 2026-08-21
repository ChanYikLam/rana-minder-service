/**
 * 持久任务执行单元（job 模块；ADR-004 §2 租约执行）。
 *
 * 一个执行周期：
 *   1. 按批量领取到期/过期租约任务（原子单胜者）；
 *   2. 逐任务分发处理器执行（业务状态在各自事务边界内收口）；
 *   3. 结算：成功 → done；处理器抛错 → 指数退避重试（attempts < maxAttempts）
 *      或 failed（达到上限，保留错误证据）；未知任务类型 → 立即 failed。
 *
 * 结算语句（complete/retry/fail）与业务事务相互独立：业务已提交而结算失败时，
 * 任务保持 running 至租约过期 → 重新领取 → 幂等重放（ADR-004 至少一次执行，
 * 业务以意图幂等键收口，迟到/重复安全）。
 */

import { computeBackoffMs, type ClaimedJobTask, type JobTaskStore } from './job-task.store';

export interface JobTaskHandler {
  execute(task: ClaimedJobTask): Promise<void>;
}

export type JobTaskHandlerRegistry = Readonly<Record<string, JobTaskHandler>>;

export class JobTaskRunner {
  constructor(
    private readonly store: JobTaskStore,
    private readonly handlers: JobTaskHandlerRegistry,
    private readonly maxAttempts: number,
    private readonly leaseMs: number,
    private readonly batchSize = 10,
  ) {}

  async runOnce(now = new Date()): Promise<number> {
    const tasks = await this.store.claim(this.batchSize, now, this.leaseMs);
    for (const task of tasks) {
      await this.executeOne(task, now);
    }
    return tasks.length;
  }

  private async executeOne(task: ClaimedJobTask, now: Date): Promise<void> {
    const handler = this.handlers[task.type];
    if (handler === undefined) {
      await this.store.fail(task.id, `未知任务类型：${task.type}（不可重试）`, now);
      return;
    }
    try {
      await handler.execute(task);
      await this.store.complete(task.id, now);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // 注意：task.attempts 是领取时已递增值（1 起，表示“已尝试第几次”），
      // 因此达到 maxAttempts 即视为重试耗尽，而非从 0 起的计数。
      if (task.attempts >= this.maxAttempts) {
        await this.store.fail(task.id, message, now);
        return;
      }
      const nextRunAt = new Date(now.getTime() + computeBackoffMs(task.attempts));
      await this.store.retry(task.id, nextRunAt, now);
    }
  }
}
