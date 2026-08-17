/**
 * HTTP 应用启动入口（ADR-001 模块化单体 + ADR-013 双入口约定）。
 *
 * 职责：
 * - 启动一个完整的 NestApplication，面向 12 个领域模块的 HTTP 接口；
 * - 通过 RANA_MINDER_CONFIG token 取 server.port / server.host；
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
 * - `AppModule` 当前未导入任何业务模块——HTTP 端点表为空；实际 API 绑定待接口契约
 *   评审与 API-Q 关闭后接入，详见 `docs/specification/接口实现规格-v1.0.md` §15。
 * - 应用可运行门槛：首批技术验证通过、真实数据技术启用门保持关闭；当前仅作
 *   "代码可编译、可启动"的工程脚手架验证。
 */

import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';

import { AppModule } from './app.module';
import { RANA_MINDER_CONFIG, type RanaMinderConfig } from './config';

async function bootstrap(): Promise<void> {
  const logger = new Logger('Bootstrap');
  const app = await NestFactory.create(AppModule, {
    bufferLogs: false,
  });

  app.enableShutdownHooks();

  const config = app.get<RanaMinderConfig>(RANA_MINDER_CONFIG);

  await app.listen(config.server.port, config.server.host);

  logger.log(
    `HTTP application listening on http://${config.server.host}:${config.server.port}`,
  );
}

bootstrap().catch((err) => {
  // 启动失败时直接以非零状态退出；具体错误原因由日志层（1.4）承接。
  // eslint-disable-next-line no-console
  console.error('Fatal: HTTP application failed to bootstrap', err);
  process.exit(1);
});