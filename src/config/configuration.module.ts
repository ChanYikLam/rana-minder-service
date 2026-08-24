/**
 * 配置模块（NestJS DynamicModule）。
 *
 * 调用方式：`ConfigurationModule.forRoot({ configFilePath? })`
 * 返回全局模块，HTTP 与 worker 两个入口均可消费同一份配置。
 *
 * 加载失败：抛出 ConfigLoadError，调用方（main.ts / main.worker.ts）以非零
 * 状态退出（ADR-010 §1.3）。
 */

import { DynamicModule, Module } from '@nestjs/common';

import { loadConfig } from './config.loader';
import { RANA_MINDER_CONFIG } from './tokens';

@Module({})
export class ConfigurationModule {
  static forRoot(options?: { readonly configFilePath?: string }): DynamicModule {
    return {
      module: ConfigurationModule,
      global: true,
      providers: [
        {
          provide: RANA_MINDER_CONFIG,
          useFactory: () => loadConfig({ configFilePath: options?.configFilePath }),
        },
      ],
      exports: [RANA_MINDER_CONFIG],
    };
  }
}
