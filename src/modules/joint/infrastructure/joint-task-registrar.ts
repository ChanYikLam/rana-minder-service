/**
 * 联合任务注册器（infrastructure；5.1 JNT 定时任务接入 TasksModule）。
 *
 * 模块初始化期向平台 TaskProcessorRegistry 注册 JNT 扫描类任务处理器，使
 * TasksModule 的调度/租约/执行管线可驱动联合活动相关后台任务。
 */

import { Inject, Injectable, OnModuleInit } from '@nestjs/common';

import {
  TASK_PROCESSOR_REGISTRY,
  type TaskProcessorRegistry,
} from '../../../platform/tasks/contracts/task-ports';
import { JOINT_REPOSITORY } from '../tokens';
import type { JointRepository } from '../application/ports/joint-repository.port';
import { createJointTaskHandlers, registerJointTasks } from './joint-tasks';

@Injectable()
export class JointTaskRegistrar implements OnModuleInit {
  constructor(
    @Inject(TASK_PROCESSOR_REGISTRY)
    private readonly registry: TaskProcessorRegistry,
    @Inject(JOINT_REPOSITORY)
    private readonly repository: JointRepository,
  ) {}

  onModuleInit(): void {
    registerJointTasks(this.registry, createJointTaskHandlers({ repository: this.repository }));
  }
}
