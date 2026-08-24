import { Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';

/**
 * PostgreSQL 连接管理（启动入口文档 §关键组件）。
 *
 * 首版桩实现：仅占位并记录生命周期；连接池初始化、实体注册与
 * RLS 上下文（ConnectionContextBuilder/ContextGuard）在数据库模块
 * 实现任务中补齐。read-model 只读投影访问经本管理器获取连接。
 */
@Injectable()
export class DbConnectionManager implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(DbConnectionManager.name);

  async onApplicationBootstrap(): Promise<void> {
    this.logger.log('数据库连接管理就绪（首版桩：连接池待后续任务初始化）');
  }

  async onApplicationShutdown(): Promise<void> {
    this.logger.log('数据库连接管理关闭');
  }
}
