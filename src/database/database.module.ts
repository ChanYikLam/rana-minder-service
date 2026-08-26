import { Global, Module } from '@nestjs/common';

/**
 * 数据库模块（结构性占位）。
 *
 * 原 `DbConnectionManager` 桩已移除（BUG-013）：真实连接管理由 adapters/db 的
 * `PostgresDbAdapter` 提供（经 AdaptersModule 注入 `DB_ADAPTER`），不再导出任何
 * 易误导的"连接管理"桩，避免后续误注入错误连接源。
 */
@Global()
@Module({})
export class DatabaseModule {}
