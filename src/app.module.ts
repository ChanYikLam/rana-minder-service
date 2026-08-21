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
 * - ObservabilityModule（平台支撑：运维与可观测性，ADR-002 §2.2 + ADR-011；
 *   当前仅注册脱敏/保留期/追踪编号三个纯规则，后续 logging/tracing/status-page
 *   子模块按 PR #32 §2.2 B 子任务次序接入）
 * - TasksModule（平台支撑：后台任务与批量编排，ADR-004，含任务信封/租约/调度）
 * - AdaptersModule（平台适配边界 @Global：DB/Casdoor/Mail 未连接态失败关闭桩，
 *   DEP-Q-001/002 锁定后替换真实实现）
 * - IdentityModule（领域：身份与资料，IFC-SM-001~003；会话认证链路接入前
 *   受保护端点统一 401 IFC-ERR-001）
 *
 * 后续接入顺序（不在本 MR 范围）：
 *
 * 1. 平台支撑：observability 子模块 logging → tracing → audit-link → status-page →
 *    health-summary → backup-report
 * 2. 通用：shared（跨模块通用能力）
 * 3. 领域：identity → organization → recruitment → joint → invitation →
 *    membership → form → file → notification → audit → stat-export →
 *    config
 * 4. 适配：adapters（casdoor / db / mail / storage）受 DEP-Q-001/002 锁定后接入
 *
 * 当前已接入：OrganizationModule、TasksModule、FileModule、AdaptersModule、FormModule。
 * 任何在此处接人的 module 不得越过 ADR-002 的状态机唯一责任与 ADR-003 的本地原子
 * 提交边界。
 */

import { Module } from '@nestjs/common';

import { CommonModule } from './common/common.module';
import { ConfigurationModule } from './config';
import { DatabaseModule } from './database/database.module';
import { ObservabilityModule } from './platform/observability/module';
import { ReadModelModule } from './platform/read-model/module';
import { CasdoorModule } from './platform/casdoor/module';
import { OrganizationModule } from './modules/organization/module';
import { TasksModule } from './platform/tasks/module';
import { FileModule } from './modules/file/module';
import { AdaptersModule } from './adapters/adapters.module';
import { IdentityModule } from './modules/identity/identity.module';
import { FormModule } from './modules/form/form.module';

@Module({
  imports: [
    ConfigurationModule.forRoot(),
    CommonModule,
    DatabaseModule,
    ObservabilityModule,
    ReadModelModule,
    CasdoorModule,
    OrganizationModule,
    TasksModule,
    FileModule,
    AdaptersModule,
    IdentityModule,
    FormModule,
  ],
  controllers: [],
  providers: [],
})
export class AppModule {}
