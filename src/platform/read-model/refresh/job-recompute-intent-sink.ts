import { Injectable, Logger } from '@nestjs/common';
import type { RecomputeIntent } from '../contracts';
import type { RecomputeIntentSink } from './recompute-intent-sink';

/**
 * 重算意图登记到 job 模块（事务发件箱，IFC-TX-008）。
 *
 * job 模块尚未实现：占位实现仅记录意图（开发期可观测），
 * 待 job 模块接入后改为登记持久化"派生重算"任务；
 * read-model 自身不得异步写库。
 */
@Injectable()
export class JobRecomputeIntentSink implements RecomputeIntentSink {
  private readonly logger = new Logger(JobRecomputeIntentSink.name);

  async submit(intent: RecomputeIntent): Promise<void> {
    this.logger.warn(
      `重算意图登记：job 模块待接入（intentId=${intent.intentId}, ` +
        `source=${intent.source.objectType}:${intent.source.objectId}@${intent.source.version}, reason=${intent.reason}）`,
    );
  }
}
