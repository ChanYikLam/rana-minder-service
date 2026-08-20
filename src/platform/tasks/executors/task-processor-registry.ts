import { Injectable } from '@nestjs/common';
import type { TaskHandler, TaskProcessorRegistry, TaskType } from '../contracts';

@Injectable()
export class InMemoryTaskProcessorRegistry implements TaskProcessorRegistry {
  private readonly handlers = new Map<TaskType, TaskHandler>();

  register(handler: TaskHandler): void {
    this.handlers.set(handler.taskType, handler);
  }

  get(taskType: TaskType): TaskHandler | undefined {
    return this.handlers.get(taskType);
  }

  list(): readonly TaskHandler[] {
    return [...this.handlers.values()];
  }
}
