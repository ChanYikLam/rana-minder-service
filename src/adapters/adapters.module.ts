/**
 * 平台适配模块（@Global；ADEP-Q-001/002 锁定前为 NotWired 失败关闭桩）。
 *
 * 提供三个共享适配边界 token：DB_ADAPTER / CASDOOR_ADAPTER / MAIL_CHANNEL_ADAPTER。
 * 真实实现（pg 连接池 + RLS 上下文、Casdoor HTTP 客户端、SMTP 渠道）在
 * 依赖基线锁定后于本模块替换 useClass，领域模块无需感知（DEP-Q-001/002）。
 */

import { Global, Module } from '@nestjs/common';

import { DB_ADAPTER, CASDOOR_ADAPTER, MAIL_CHANNEL_ADAPTER } from './tokens';
import { NotWiredDbAdapter } from './db/not-wired-db.adapter';
import { NotWiredCasdoorAdapter } from './casdoor/not-wired-casdoor.adapter';
import { NotWiredMailChannelAdapter } from './mail/not-wired-mail.adapter';

@Global()
@Module({
  providers: [
    { provide: DB_ADAPTER, useClass: NotWiredDbAdapter },
    { provide: CASDOOR_ADAPTER, useClass: NotWiredCasdoorAdapter },
    { provide: MAIL_CHANNEL_ADAPTER, useClass: NotWiredMailChannelAdapter },
  ],
  exports: [DB_ADAPTER, CASDOOR_ADAPTER, MAIL_CHANNEL_ADAPTER],
})
export class AdaptersModule {}
