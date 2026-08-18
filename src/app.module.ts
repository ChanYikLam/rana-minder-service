/**
 * 应用根模块（ADR-001 模块化单体 + ADR-013 应用技术栈）。
 *
 * 当前已接入：
 * - ConfigurationModule（1.5 配置加载骨架）：全局模块，HTTP 与 worker 共享同一份
 *   RanaMinderConfig；密钥以 ${env:...} / ${file:...} 引用形式提供，详见
 *   src/config/secret-ref.ts。
 * - CommonModule（公共组件：错误定义、枚举常量、校验原语，无外部依赖）
 * - DatabaseModule（数据持久化：连接池初始化、实体注册，首版桩）
 * - ReadModelModule（平台支撑：派生入口与读模型，ADR-002 §2.2）
 *
 * 后续接入顺序（不在本次提交范围）：
 *
 * 1. 平台支撑：observability 适配层（LogWriterAdapter、TraceContextAdapter）→
 *    job（持久任务与租约，依赖 1.3 通用任务信封）
 * 2. 通用：shared（跨模块通用能力）
 * 3. 领域：identity → organization → recruitment → joint → invitation →
 *    membership → form → file → notification → audit → stat-export →
 *    config
 * 4. 适配：adapters（casdoor / db / mail / storage）受 DEP-Q-001/002 锁定后接入
 *
 * 任何在此处接人的 module 不得越过 ADR-002 的状态机唯一责任与 ADR-003 的本地原子
 * 提交边界。
 */

import { Module } from '@nestjs/common';

import { CommonModule } from './common/common.module';
import { ConfigurationModule } from './config';
import { DatabaseModule } from './database/database.module';
import { ReadModelModule } from './platform/read-model/module';

@Module({
  imports: [ConfigurationModule.forRoot(), CommonModule, DatabaseModule, ReadModelModule],
  controllers: [],
  providers: [],
})
export class AppModule {}
