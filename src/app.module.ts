import { Module } from '@nestjs/common';
import { CommonModule } from './common/common.module';
import { ConfigModule } from './config/config.module';
import { DatabaseModule } from './database/database.module';
import { ReadModelModule } from './platform/read-model/module';

/**
 * 根装配（对应启动入口文档 §1 注册顺序）。
 *
 * 首版先装配基础模块与首个平台支撑模块 read-model；
 * 领域模块（identity/organization/recruitment/joint/invitation/membership/
 * form/file/notification/audit/stat-export/config）与平台支撑
 * （job/ops）在各自实现任务中按依赖顺序补入：
 * identity → organization → recruitment → joint → invitation → membership →
 * form → file → notification → audit → stat-export → config → read-model → job → ops
 */
@Module({
  imports: [ConfigModule, CommonModule, DatabaseModule, ReadModelModule],
})
export class AppModule {}
