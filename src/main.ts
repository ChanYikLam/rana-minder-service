import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { AppModule } from './app.module';
import { APP_CONFIG } from './config/config.module';
import type { AppConfig } from './config/config.loader';

/**
 * HTTP 应用入口（启动入口文档 §4）。
 * 承载页面交互接入、命令/查询、逐请求授权、同步本地事务与提交后任务意图登记。
 */
async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  const config = app.get<AppConfig>(APP_CONFIG);
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  app.enableShutdownHooks();
  await app.listen(config.app.port);
}

void bootstrap();
