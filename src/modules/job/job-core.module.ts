/**
 * job 核心模块（持久任务领取/执行；HTTP 与 worker 入口共用，不含轮询器）。
 *
 * 依赖：AdaptersModule（DB_ADAPTER）、IdentityModule（APPLY_PROFILE_SYNC_STEP_USE_CASE
 * 与 IdentityUnitOfWork——资料同步/读回任务处理器）。
 *
 * JobWorkerModule 追加 JobTaskPoller 轮询器，仅由 worker 入口消费
 * （main.worker.ts → WorkerAppModule），HTTP 进程不运行任务轮询。
 */

import { Module } from '@nestjs/common';

import { AdaptersModule } from '../../adapters/adapters.module';
import { DB_ADAPTER } from '../../adapters/tokens';
import { RANA_MINDER_CONFIG } from '../../config';
import { IdentityModule } from '../identity/identity.module';
import { ObservabilityModule } from '../../platform/observability/module';

import { PostgresJobTaskStore, type JobTaskStore } from './job-task.store';
import { JobTaskRunner, type JobTaskHandlerRegistry } from './job-task-runner';
import { ProfileSyncTaskHandler } from './profile-sync-task.handler';
import { ProfileNameWriteTaskHandler } from './profile-name-write-task.handler';
import { JOB_TASK_STORE, JOB_TASK_HANDLERS } from './tokens';
import { JobNestController } from './interfaces/nest/job.nest.controller';
import {
  APPLY_PROFILE_SYNC_STEP_USE_CASE,
  APPLY_NAME_CORRECTION_WRITE_USE_CASE,
} from '../identity/tokens';
import { IdentityUnitOfWork } from '../identity/infrastructure/unit-of-work';

@Module({
  imports: [AdaptersModule, IdentityModule, ObservabilityModule],
  controllers: [JobNestController],
  providers: [
    {
      provide: JOB_TASK_STORE,
      useFactory: (db) => new PostgresJobTaskStore(db),
      inject: [DB_ADAPTER],
    },
    {
      provide: ProfileSyncTaskHandler,
      useFactory: (applyStep, uow) => new ProfileSyncTaskHandler(applyStep, uow),
      inject: [APPLY_PROFILE_SYNC_STEP_USE_CASE, IdentityUnitOfWork],
    },
    {
      provide: JOB_TASK_HANDLERS,
      useFactory: (syncHandler, nameWriteHandler) => ({
        profile_sync: syncHandler,
        profile_readback: syncHandler,
        profile_name_write: nameWriteHandler,
      }),
      inject: [ProfileSyncTaskHandler, ProfileNameWriteTaskHandler],
    },
    {
      provide: ProfileNameWriteTaskHandler,
      useFactory: (applyNameWrite, uow) => new ProfileNameWriteTaskHandler(applyNameWrite, uow),
      inject: [APPLY_NAME_CORRECTION_WRITE_USE_CASE, IdentityUnitOfWork],
    },
    {
      provide: JobTaskRunner,
      useFactory: (
        store: JobTaskStore,
        handlers: JobTaskHandlerRegistry,
        config: { job: { maxAttempts: number; defaultLeaseMs: number } },
      ) => new JobTaskRunner(store, handlers, config.job.maxAttempts, config.job.defaultLeaseMs),
      inject: [JOB_TASK_STORE, JOB_TASK_HANDLERS, RANA_MINDER_CONFIG],
    },
  ],
  exports: [JobTaskRunner, JOB_TASK_STORE, ProfileSyncTaskHandler],
})
export class JobCoreModule {}
