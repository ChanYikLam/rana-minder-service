import { Inject, Injectable, Logger } from '@nestjs/common';
import { RANA_MINDER_CONFIG, type RanaMinderConfig } from '../../../config';
import { TaskScheduler } from '../scheduler/task-scheduler';

@Injectable()
export class TasksWorker {
  private readonly logger = new Logger(TasksWorker.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private stopping = false;

  constructor(
    private readonly scheduler: TaskScheduler,
    @Inject(RANA_MINDER_CONFIG) private readonly config: RanaMinderConfig,
  ) {}

  start(workerId = 'tasks-worker'): void {
    if (this.timer !== null) return;
    this.logger.log(
      `后台任务调度器启动：workerId=${workerId}, interval=${this.config.job.schedulerIntervalMs}ms, leaseMs=${this.config.job.defaultLeaseMs}`,
    );

    const run = async (): Promise<void> => {
      if (this.stopping || this.running) return;
      this.running = true;
      try {
        await this.scheduler.runOnce(workerId, new Date());
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        this.logger.warn(`调度循环单次执行失败：${reason}`);
      } finally {
        this.running = false;
      }
    };

    void run();
    this.timer = setInterval(() => {
      void run();
    }, this.config.job.schedulerIntervalMs);
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.logger.log('后台任务调度器已停止');
  }
}
