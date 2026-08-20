/**
 * Worker 根模块（main.worker.ts 专用：AppModule + JobWorkerModule）。
 *
 * 与 HTTP 入口共用 AppModule 的同一份模块图（配置/平台支撑/领域模块），
 * 追加 JobWorkerModule 提供持久任务轮询器；本入口不创建 HTTP 监听器、
 * 不注册任何 controller 路由（main.worker.ts 使用 NestApplicationContext）。
 */

import { Module } from '@nestjs/common';

import { AppModule } from './app.module';
import { JobWorkerModule } from './modules/job/job-worker.module';

@Module({
  imports: [AppModule, JobWorkerModule],
})
export class WorkerAppModule {}