import { Inject, Injectable, Logger } from '@nestjs/common';
import { RANA_MINDER_CONFIG, type RanaMinderConfig } from '../../../config';
import { TaskScheduler } from '../scheduler/task-scheduler';

@Injectable()
export class TasksWorker {
  private readonly logger = new Logger(TasksWorker.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private stopping = false;
  private currentRun: Promise<void> | null = null;

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
      // BUG-012 修复：仅在真正启动一轮时才把 currentRun 指向在途 promise。
      // 早退（stopping/running）的调用不覆盖 currentRun，避免 stop() 等待期间
      // 被"立即 resolve"的空轮次覆盖，导致真正在途轮次未被排空。
      const runPromise = (async () => {
        try {
          await this.scheduler.runOnce(workerId, new Date());
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err);
          this.logger.warn(`调度循环单次执行失败：${reason}`);
        } finally {
          this.running = false;
        }
      })();
      this.currentRun = runPromise;
      return runPromise;
    };

    const tracked = (): Promise<void> => run();

    void tracked();
    this.timer = setInterval(() => {
      void tracked();
    }, this.config.job.schedulerIntervalMs);
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    // 排空在途轮次：等待当前 runOnce 完成再退出，避免硬切导致任务
    // 落入 UNCERTAIN（与 BUG-004 恢复重放叠加）。
    if (this.currentRun !== null) {
      try {
        await this.currentRun;
      } catch {
        /* run 内部已捕获并记录，停止阶段无需再抛 */
      }
      this.currentRun = null;
    }
    this.logger.log('后台任务调度器已停止');
  }
}
