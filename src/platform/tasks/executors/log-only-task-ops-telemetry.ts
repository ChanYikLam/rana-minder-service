import { Injectable, Logger } from '@nestjs/common';
import type { TaskOpsEvidence, TaskOpsTelemetryPort } from '../contracts';

@Injectable()
export class LogOnlyTaskOpsTelemetry implements TaskOpsTelemetryPort {
  private readonly logger = new Logger(LogOnlyTaskOpsTelemetry.name);

  async report(evidence: TaskOpsEvidence): Promise<void> {
    this.logger.warn(
      `任务 ops 遥测（待接入 ops 模块）：event=${evidence.event}, ref=${evidence.ref}, reason=${evidence.reason}`,
    );
  }
}
