/**
 * 平台统一能力 · Casdoor 统一适配（ADR-009 §2.1、CAS-*）。
 *
 * 这是浏览器登录/回调之外所有 Casdoor 资料读取、账号状态核验、Group 查询/写入、
 * 事件接收和周期对账的唯一应用边界。领域模块和后台任务只依赖本模块导出的端口，
 * 不得直接依赖 Casdoor SDK/HTTP/响应结构。
 *
 * 当前开发态使用内存桩（InMemoryCasdoorStore / InMemoryMappingStore），真实
 * v3.108.0 HTTP/SDK 适配器由后续 infrastructure 任务替换；未验证能力不得写成
 * 已存在接口（CAS-CAP-004~014）。
 */

import { Module } from '@nestjs/common';

import {
  CASDOOR_CLOCK,
  CASDOOR_READ_PORT,
  CASDOOR_WRITE_PORT,
  CASDOOR_MAPPING_STORE,
  type ClockPort,
} from './contracts/ports';
import { FreshnessRegistry } from './domain/freshness-registry';
import { InMemoryCasdoorStore } from './infrastructure/in-memory-casdoor-store';
import { InMemoryMappingStore } from './infrastructure/in-memory-mapping-store';
import { SystemClock } from './infrastructure/system-clock';
import { CasdoorReadService } from './application/casdoor-read.service';
import { CasdoorWriteService } from './application/casdoor-write.service';
import { CasdoorReconcileService } from './application/casdoor-reconcile.service';
import { CasdoorEventService } from './application/casdoor-event.service';

@Module({
  providers: [
    { provide: CASDOOR_CLOCK, useFactory: (): ClockPort => new SystemClock() },
    {
      provide: CASDOOR_READ_PORT,
      useFactory: () => new InMemoryCasdoorStore(),
    },
    {
      provide: CASDOOR_WRITE_PORT,
      useExisting: CASDOOR_READ_PORT,
    },
    { provide: CASDOOR_MAPPING_STORE, useClass: InMemoryMappingStore },
    FreshnessRegistry,
    CasdoorReadService,
    CasdoorWriteService,
    CasdoorReconcileService,
    CasdoorEventService,
  ],
  exports: [
    CASDOOR_CLOCK,
    CASDOOR_READ_PORT,
    CASDOOR_WRITE_PORT,
    CASDOOR_MAPPING_STORE,
    FreshnessRegistry,
    CasdoorReadService,
    CasdoorWriteService,
    CasdoorReconcileService,
    CasdoorEventService,
  ],
})
export class CasdoorModule {}
