/**
 * 后台任务与批量编排入口（ADR-001 模块化单体 + ADR-013 双入口约定）。
 *
 * 职责：
 * - 启动一个独立的 NestApplicationContext（不创建 HTTP 服务），用于后台任务
 *   执行单元、调度器、租约处理器、批量重算与对账任务；
 * - 不注册 controllers、不暴露 HTTP 路由、不绑定端口；
 * - 通过 RANA_MINDER_CONFIG token 取 job.schedulerIntervalMs / observability.logLevel；
 * - 启用优雅关闭，确保租约释放、任务尝试状态与持久化结果在进程退出前被处理。
 *
 * 与 HTTP 入口的关系：
 * - 本入口与 `main.ts` 共用 `AppModule` 的同一份模块图，但本入口不会创建 HTTP
 *   监听器，也不会注册任何 controller；
 * - HTTP 入口面向外部调用方，本入口面向持久任务池与内部调度；
 * - 跨入口追踪（ADR-011 §2.2）通过 `TraceContextAdapter` 串接请求—任务—外部调用，
 *   后续在 1.4 日志骨架阶段接入。
 *
 * 受控状态：
 * - 启动骨架已就绪，ConfigurationModule 已挂入；
 * - 持久任务库、消息设施、租约实现与具体重试/退避参数均待
 *   `docs/engineering/依赖与版本基线-v1.0.md`（DEP-001）首批技术验证后选定；
 * - 1.3 通用任务信封（XCC-JOB-001 与 `DATA-JOB-001..004`）落地后，本入口会接入
 *   `PlatformTasksModule` 与 `PlatformJobModule`；当前不导入任何业务模块。
 */

import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';

import { AppModule } from './app.module';
import { RANA_MINDER_CONFIG, type RanaMinderConfig } from './config';

async function bootstrap(): Promise<void> {
  const logger = new Logger('WorkerBootstrap');
  // 使用 NestApplicationContext 而非 NestApplication：不监听 HTTP、不暴露端口。
  const appContext = await NestFactory.createApplicationContext(AppModule, {
    bufferLogs: false,
  });

  appContext.enableShutdownHooks();

  const config = appContext.get<RanaMinderConfig>(RANA_MINDER_CONFIG);

  logger.log(
    `Worker application context started; scheduler interval=${config.job.schedulerIntervalMs}ms, log level=${config.observability.logLevel}.`,
  );
}

bootstrap().catch((err) => {
  // 启动失败时直接以非零状态退出；具体错误原因由日志层（1.4）承接。
  console.error('Fatal: worker application failed to bootstrap', err);
  process.exit(1);
});
