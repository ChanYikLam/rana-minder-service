import { Global, Module } from '@nestjs/common';
import { loadConfig } from './config.loader';

export const APP_CONFIG = Symbol('APP_CONFIG');

/**
 * 配置模块：全局提供已校验的 typed 配置对象（启动入口文档 §6）。
 */
@Global()
@Module({
  providers: [{ provide: APP_CONFIG, useFactory: () => loadConfig() }],
  exports: [APP_CONFIG],
})
export class ConfigModule {}
