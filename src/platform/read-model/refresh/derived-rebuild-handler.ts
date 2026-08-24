import { Injectable } from '@nestjs/common';
import type { RecomputeIntent } from '../contracts';
import { RefreshHandler } from './refresh-handler';

/**
 * 派生重算任务处理器（对 job 模块暴露）。
 *
 * job 模块任务类型"派生重算"（DerivedRebuildHandler，job README §6.5）
 * 在领取持久任务后调用本处理器；任务载荷携带 RecomputeIntent
 * （intentId 同时作为幂等依据）。本处理器是薄壳，业务解释归 read-model。
 */
@Injectable()
export class DerivedRebuildHandler {
  constructor(private readonly refresh: RefreshHandler) {}

  async handle(intent: RecomputeIntent): Promise<void> {
    await this.refresh.consume(intent);
  }
}
