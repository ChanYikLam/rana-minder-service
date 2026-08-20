import { Injectable } from '@nestjs/common';
import type { TaskHandler, TaskRecord } from '../../contracts';
import { TaskType } from '../../contracts';
import type { BatchOrchestrator } from '../../batch/batch-orchestrator';

@Injectable()
export class BatchExecutionHandler implements TaskHandler {
  readonly taskType = TaskType.BATCH_EXECUTION;

  constructor(private readonly orchestrator: BatchOrchestrator) {}

  async handle(task: TaskRecord): Promise<void> {
    await this.orchestrator.executeFrozenBatch(task);
  }
}
