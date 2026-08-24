import { Injectable, Logger } from '@nestjs/common';
import { hostname } from 'node:os';
import type { TaskHandler, TaskRecord } from '../../contracts';
import { TaskType } from '../../contracts';
import { ExportGenerationCommand } from '../../../../modules/stat-export/application/commands/export-generation.command';

/**
 * 导出生成后台任务处理器（5.4.4，EXP-001/EXP-003 异步生成）。
 *
 * 接入 stat-export 模块的 ExportGenerationCommand（类 Token 注入，由 TasksModule
 * 引入 StatExportModule 提供）。任务 payload 约定：
 *
 *   { intent: 'generate', exportId: string }
 *
 * 缺失/未知 payload 容忍处理：仅告警不抛错（与 NotificationDeliveryHandler 同口径，
 * 避免脏投递反复重试无意义失败）；命令执行失败向上抛出，交由任务管道进入
 * 失败重试/人工介入，不静默吞掉（IFC-ERR-008 版本冲突等必须可见可重试）。
 *
 * 幂等说明：生成命令按任务版本/文件哈希幂等（EXP-003），管道重复投递安全。
 *
 * workerId 取「主机名-进程号」（评审⑧）：多副本部署时各进程租约持有者不同，
 * 命令层据此做租约互斥——同一任务不会被两个副本同时视为"本 worker 持有"，
 * 避免重复渲染与重复写对象存储；固定字面量会在多副本下破坏租约排他性。
 */
const WORKER_ID = `${hostname()}-${process.pid}`;

@Injectable()
export class ExportGenerationHandler implements TaskHandler {
  readonly taskType = TaskType.EXPORT_GENERATION;
  private readonly logger = new Logger(ExportGenerationHandler.name);

  constructor(private readonly generation: ExportGenerationCommand) {}

  async handle(task: TaskRecord): Promise<void> {
    this.logger.log(`ExportGenerationHandler 开始处理导出生成任务：taskId=${task.taskId}`);

    const payload = task.payload as { intent?: string; exportId?: string } | undefined;

    if (payload?.intent !== 'generate' || typeof payload.exportId !== 'string') {
      this.logger.warn(
        `ExportGenerationHandler 未知或缺失任务意图: taskId=${task.taskId}, payload=${JSON.stringify(payload)}`,
      );
      return;
    }

    await this.generation.execute({
      exportId: payload.exportId,
      workerId: WORKER_ID,
    });
    this.logger.log(
      `ExportGenerationHandler 导出生成任务处理完成: taskId=${task.taskId}, exportId=${payload.exportId}`,
    );
  }
}
