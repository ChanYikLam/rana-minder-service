import { Global, Module } from '@nestjs/common';
import { DbConnectionManager } from './db-connection-manager';

/**
 * 数据库模块：连接池初始化、实体注册（首版桩）。
 */
@Global()
@Module({
  providers: [DbConnectionManager],
  exports: [DbConnectionManager],
})
export class DatabaseModule {}
