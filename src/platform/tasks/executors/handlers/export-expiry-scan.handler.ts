import { Injectable, Logger } from '@nestjs/common';
import type { TaskHandler, TaskRecord } from '../../contracts';
import { TaskType } from '../../contracts';
import { ExportExpirySweepCommand } from '../../../../modules/stat-export/application/commands/export-expiry-sweep.command';

/**
 * 导出过期扫描后台任务处理器（5.4.4，转换 8，EXP-003 有效期收敛 / AUD-009 清理）。
 *
 * 接入 stat-export 模块的 ExportExpirySweepCommand（类 Token 注入，由 TasksModule
 * 引入 StatExportModule 提供）。每执行一次即对仓储内已到期的可下载任务做一轮
 * 过期收敛 + 对象存储清理（命令幂等，重复扫描无副作用）。
 *
 * 调度说明（入队点）：当前未接入周期性入队器——扫描任务由运维轮询触发
 * （按需向 TASK_REPOSITORY 投递 taskType='export-expiry-scan' 的任务即可，
 * payload 可为空），或后续里程碑经 TaskIntentOutbox 注册周期意图；本处理器
 * 不自建定时器（避免与平台调度器的租约/重试语义脱节的脆弱实现）。
 *
 * 命令失败向上抛出，交由任务管道进入失败重试/人工介入，不静默吞掉。
 */
@Injectable()
export class ExportExpiryScanHandler implements TaskHandler {
  readonly taskType = TaskType.EXPORT_EXPIRY_SCAN;
  private readonly logger = new Logger(ExportExpiryScanHandler.name);

  constructor(private readonly sweep: ExportExpirySweepCommand) {}

  async handle(task: TaskRecord): Promise<void> {
    this.logger.log(`ExportExpiryScanHandler 开始处理导出过期扫描：taskId=${task.taskId}`);
    const result = await this.sweep.run();
    this.logger.log(
      `ExportExpiryScanHandler 扫描完成: taskId=${task.taskId}, expired=${result.expired}, disposed=${result.disposed}`,
    );
  }
}
