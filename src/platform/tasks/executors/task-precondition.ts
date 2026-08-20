import { Injectable } from '@nestjs/common';
import type { TaskRecord } from '../contracts';

export const TASK_PRECONDITION_PORT = Symbol('TASK_PRECONDITION_PORT');

export interface TaskPreconditionPort {
  verify(task: TaskRecord): Promise<{ ok: boolean; reason?: string }>;
}

@Injectable()
export class DevelopmentTaskPrecondition implements TaskPreconditionPort {
  async verify(task: TaskRecord): Promise<{ ok: boolean; reason?: string }> {
    return { ok: true, reason: `development-precondition-check:${task.taskId}` };
  }
}
