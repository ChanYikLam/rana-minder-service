/**
 * 后台任务轮询器（job 模块；main.worker 入口消费）。
 *
 * 启动后立即跑一轮并进入 schedulerIntervalMs 周期轮询；单轮内部串行执行，
 * 用 running 标志防止轮询重叠（慢执行不堆积并发）；任何单轮失败仅告警，
 * 不终止 worker（下一轮继续），异常细节由 observability 日志层承接。
 */

import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from '@nestjs/common';

import { RANA_MINDER_CONFIG, type RanaMinderConfig } from '../../config';
import { JobTaskRunner } from './job-task-runner';

@Injectable()
export class JobTaskPoller implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(JobTaskPoller.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly runner: JobTaskRunner,
    @Inject(RANA_MINDER_CONFIG)
    private readonly config: RanaMinderConfig,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.tick('启动首轮');
    // 不用 .unref()：本轮询器是 worker 进程自身的保活定时器，须持有事件循环引用以
    // 保证任务领取循环持续运行（否则首轮后进程可能退出、任务静默停止）。与
    // TasksWorker 的 setInterval 行为保持一致；退出经 onApplicationShutdown 清理。
    this.timer = setInterval(() => void this.tick('周期轮询'), this.config.job.schedulerIntervalMs);
  }

  onApplicationShutdown(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async tick(label: string): Promise<void> {
    if (this.running) {
      return;
    }
    this.running = true;
    try {
      const count = await this.runner.runOnce();
      if (count > 0) {
        this.logger.log(`任务执行：${label} 完成 ${count} 个任务`);
      }
    } catch (error) {
      this.logger.warn(
        `任务轮询异常（${label}）：${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      this.running = false;
    }
  }
}
