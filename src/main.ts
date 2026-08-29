/**
 * HTTP 应用启动入口（ADR-001 模块化单体 + ADR-013 双入口约定）。
 *
 * 职责：
 * - 启动一个完整的 NestApplication，面向 12 个领域模块的 HTTP 接口；
 * - 通过 RANA_MINDER_CONFIG token 取 server.port / server.host；
 * - 全局启用 ValidationPipe（白名单 + transform），承载页面交互接入、
 *   命令/查询、逐请求授权、同步本地事务与提交后任务意图登记；
 * - 启用优雅关闭，遵循 server.gracefulShutdownTimeoutMs；
 * - 不引入全局前缀（待接口契约评审 API-Q-001 关闭后由适配层统一注入）。
 *
 * 与 worker 入口的关系：
 * - 本入口与 `main.worker.ts` 共用 `AppModule` 的同一份模块图，但 worker 不启动
 *   HTTP 服务、不注册 controllers。
 * - 状态页只读端点（`observability` 模块）按 ADR-011 收口，仅在此 HTTP 入口暴露；
 *   worker 入口不暴露任何 HTTP 路由，也不直接响应状态页请求。
 *
 * 受控状态：
 * - 启动骨架已就绪，ConfigurationModule 已挂入；HTTP 端口与监听地址来自配置。
 * - `AppModule` 已接入 read-model 平台支撑与 identity 领域模块；identity 端点
 *   （/api/auth/profile、/api/auth/session 等）已注册路由，会话认证链路接入前
 *   由 AuthGuard 统一 401 IFC-ERR-001（失败关闭），见 src/modules/identity。
 * - 应用可运行门槛：首批技术验证通过、真实数据技术启用门保持关闭；当前仅作
 *   "代码可编译、可启动"的工程脚手架验证。
 */

import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';

import { AppModule } from './app.module';
import { RANA_MINDER_CONFIG, type RanaMinderConfig } from './config';
import { NEST_LOGGER_SERVICE } from './platform/observability/logging/tokens';
import { type NestLoggerServiceAdapter } from './platform/observability/infrastructure/nest-logger.adapter';

async function bootstrap(): Promise<void> {
  // 关闭 NestJS 默认 console logger——避免启动横幅/路由表/异常以非脱敏形式
  // 打到 stdout；observability NestLoggerServiceAdapter 在 useLogger() 之后接管。
  const app = await NestFactory.create(AppModule, {
    bufferLogs: false,
    logger: ["error", "warn"], // TEMP-DEBUG
  });

  // 通过 DI 取 observability 的 NestLoggerServiceAdapter：经 sanitize 后镜像 stdout。
  const logger = app.get<NestLoggerServiceAdapter>(NEST_LOGGER_SERVICE);
  app.useLogger(logger);

  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  app.enableShutdownHooks();

  const config = app.get<RanaMinderConfig>(RANA_MINDER_CONFIG);

  await app.listen(config.server.port, config.server.host);

  logger.log(
    `HTTP application listening on http://${config.server.host}:${config.server.port}`,
    'Bootstrap',
  );
}

bootstrap().catch((err) => {
  // 启动失败时直接以非零状态退出；具体错误原因由 observability 日志层承接。
  console.error('Fatal: HTTP application failed to bootstrap', err);
  process.exit(1);
});
