/**
 * job worker 模块（worker 入口专用：JobCoreModule + 轮询器）。
 *
 * 由 WorkerAppModule 引入；HTTP 进程（AppModule）不引入本模块，不运行任务轮询。
 */

import { Module } from '@nestjs/common';

import { JobCoreModule } from './job-core.module';
import { JobTaskPoller } from './job-task.poller';

@Module({
  imports: [JobCoreModule],
  providers: [JobTaskPoller],
})
export class JobWorkerModule {}