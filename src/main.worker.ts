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
 * - 已接入 JobWorkerModule（JobCoreModule + JobTaskPoller）：轮询 job_tasks 表
 *   领取 profile_sync / profile_readback 任务并交 identity 用例执行
 *   （ADR-004 租约执行单元；数据访问经 DB_ADAPTER，当前为未连接桩，
 *   领取即失败并告警，真实连接层由 adapters/db 接入后生效）；
 * - 已接入 read-model 平台支撑模块：派生刷新/重建（RecomputeIntent）等批量任务
 *   消费接力随 job 领取循环落地。
 */

import { NestFactory } from '@nestjs/core';

import { WorkerAppModule } from './worker-app.module';
import { RANA_MINDER_CONFIG, type RanaMinderConfig } from './config';
import { NEST_LOGGER_SERVICE } from './platform/observability/logging/tokens';
import { type NestLoggerServiceAdapter } from './platform/observability/infrastructure/nest-logger.adapter';

async function bootstrap(): Promise<void> {
  // 使用 NestApplicationContext 而非 NestApplication：不监听 HTTP、不暴露端口。
  // 关闭 NestJS 默认 console logger；observability NestLoggerServiceAdapter 接管。
  const appContext = await NestFactory.createApplicationContext(WorkerAppModule, {
    bufferLogs: false,
    logger: false,
  });

  const logger = appContext.get<NestLoggerServiceAdapter>(NEST_LOGGER_SERVICE);
  appContext.useLogger(logger);

  appContext.enableShutdownHooks();

  const config = appContext.get<RanaMinderConfig>(RANA_MINDER_CONFIG);

  logger.log(
    `Worker application context started; scheduler interval=${config.job.schedulerIntervalMs}ms, log level=${config.observability.logLevel}.`,
    'WorkerBootstrap',
  );
}

bootstrap().catch((err) => {
  // 启动失败时直接以非零状态退出；具体错误原因由 observability 日志层承接。
  console.error('Fatal: worker application failed to bootstrap', err);
  process.exit(1);
});
