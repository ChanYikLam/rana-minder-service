import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

/**
 * 后台任务入口（启动入口文档 §5）。
 * 以 NestJS 应用上下文启动（不监听 HTTP），承载 Casdoor 写入与回读、
 * 邮件投递、文件检查/预览、导出生成、到期任务、正式删除、派生重算和对账。
 */
async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule);
  app.enableShutdownHooks();
  // TODO(后续任务): job 模块任务领取循环在 worker 入口启动
}

void bootstrap();
