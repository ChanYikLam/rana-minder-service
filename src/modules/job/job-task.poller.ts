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
    this.timer = setInterval(() => void this.tick('周期轮询'), this.config.job.schedulerIntervalMs);
    this.timer.unref();
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
