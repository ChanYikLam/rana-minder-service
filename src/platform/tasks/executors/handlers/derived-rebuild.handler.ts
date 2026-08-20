import { Injectable } from '@nestjs/common';
import type { RecomputeIntent } from '../../../read-model/contracts';
import { RefreshHandler } from '../../../read-model/refresh';
import type { TaskHandler, TaskRecord } from '../../contracts';
import { TaskType } from '../../contracts';

@Injectable()
export class DerivedRebuildTaskHandler implements TaskHandler<RecomputeIntent> {
  readonly taskType = TaskType.DERIVED_REBUILD;

  constructor(private readonly refresh: RefreshHandler) {}

  async handle(task: TaskRecord<RecomputeIntent>): Promise<void> {
    await this.refresh.consume(task.payload);
  }
}
