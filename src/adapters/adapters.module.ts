/**
 * 平台适配模块（@Global；ADEP-Q-001/002 锁定前默认 NotWired 失败关闭桩）。
 *
 * 提供三个共享适配边界 token：DB_ADAPTER / CASDOOR_ADAPTER / MAIL_CHANNEL_ADAPTER。
 *
 * 接线策略（T2）：
 * - DB_ADAPTER：默认绑定 NotWiredDbAdapter（fail-closed，未连接态任何操作抛
 *   DbUnavailableError）。当显式开启 `ADAPTERS_DB_REAL=1` 且能解析到数据库配置时，
 *   绑定真实 PostgresDbAdapter（pg 连接池 + 事务 + RLS 上下文，ADR-005）。
 * - CASDOOR_ADAPTER / MAIL_CHANNEL_ADAPTER：维持 NotWired 失败关闭桩，待
 *   DEP-Q-001/002 锁定与 T3 接线。
 *
 * 可用性开关约定：真实适配器一律需显式开启（与 ORG_DEV_ACTOR_HEADER 一致），
 * 生产默认 fail-closed；单元测试不连接外部系统，保持桩行为。
 *
 * 注：本模块为 @Global 普通模块（非 DynamicModule），DB_ADAPTER 通过工厂按
 * `ADAPTERS_DB_REAL` 开关选择桩或真实实现，各领域模块可照常以静态导入方式
 * 复用（无需改动 importers）。
 */

import { Global, Module } from '@nestjs/common';

import { DB_ADAPTER, CASDOOR_ADAPTER, MAIL_CHANNEL_ADAPTER } from './tokens';
import { NotWiredDbAdapter } from './db/not-wired-db.adapter';
import { PostgresDbAdapter } from './db/postgres-db-adapter';
import { NotWiredCasdoorAdapter } from './casdoor/not-wired-casdoor.adapter';
import { NotWiredMailChannelAdapter } from './mail/not-wired-mail.adapter';
import { RANA_MINDER_CONFIG, type RanaMinderConfig } from '../config';
import { isSecretRef, resolveSecret } from '../config';

/** 是否启用真实 PostgreSQL 适配（fail-closed：默认关闭）。 */
export function realDbEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.ADAPTERS_DB_REAL === '1';
}

@Global()
@Module({
  providers: [
    {
      provide: DB_ADAPTER,
      useFactory: (config: RanaMinderConfig) => {
        if (!realDbEnabled()) {
          return new NotWiredDbAdapter();
        }
        const db = config.database;
        // passwordRef 可能是明文（由 DATABASE_PASSWORD 直接回落）或 ${env:...} 引用；
        // 仅对引用形式执行解密，明文直接使用（ADR-010 最小披露）。
        const password = isSecretRef(db.passwordRef)
          ? resolveSecret(db.passwordRef)
          : db.passwordRef;
        return new PostgresDbAdapter({
          host: db.host,
          port: db.port,
          database: db.name,
          user: db.user,
          password,
          ssl: db.ssl,
        });
      },
      inject: [RANA_MINDER_CONFIG],
    },
    { provide: CASDOOR_ADAPTER, useClass: NotWiredCasdoorAdapter },
    { provide: MAIL_CHANNEL_ADAPTER, useClass: NotWiredMailChannelAdapter },
  ],
  exports: [DB_ADAPTER, CASDOOR_ADAPTER, MAIL_CHANNEL_ADAPTER],
})
export class AdaptersModule {}
