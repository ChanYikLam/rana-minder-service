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

/**
 * 生产默认前置检查实现：fail-closed（拒绝）。
 * 真实授权接入前，禁止任何任务绕过前置检查执行；Development 桩仅用于非生产环境。
 */
@Injectable()
export class DenyAllTaskPrecondition implements TaskPreconditionPort {
  async verify(task: TaskRecord): Promise<{ ok: boolean; reason?: string }> {
    return { ok: false, reason: `production-precondition-not-configured:${task.taskId}` };
  }
}
