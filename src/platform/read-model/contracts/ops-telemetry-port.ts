import { Injectable, Logger } from '@nestjs/common';

/** ops 遥测端口注入令牌（OpsTelemetryPort 为接口，注入须用显式 token） */
export const OPS_TELEMETRY_PORT = Symbol('OPS_TELEMETRY_PORT');

/** 技术证据事件（C5.3：重建失败/失效失败/积压进入 ops 脱敏日志与内置状态） */
export const OpsTelemetryEventType = {
  REBUILD_FAILED: 'REBUILD_FAILED',
  INVALIDATION_FAILED: 'INVALIDATION_FAILED',
  REFRESH_FAILED: 'REFRESH_FAILED',
  REBUILD_BACKLOG: 'REBUILD_BACKLOG',
} as const;

export type OpsTelemetryEventType = (typeof OpsTelemetryEventType)[keyof typeof OpsTelemetryEventType];

/** 技术证据（脱敏：只含类型/标识/原因，不含业务负载） */
export interface OpsTelemetryEvidence {
  /** 事件类型 */
  readonly event: OpsTelemetryEventType;
  /** 关联投影/来源（脱敏标识，可追踪） */
  readonly ref: string;
  /** 原因（技术性，脱敏） */
  readonly reason: string;
  /** 发生时间（服务端可信时钟，ISO 8601） */
  readonly occurredAt: string;
}

/**
 * ops 遥测端口（C5.3/ADR-011）。
 *
 * 重建失败、失效失败等技术证据进入 ops 模块的脱敏日志与内置状态；
 * read-model 不自行断言、不自行做技术状态结论。
 */
export interface OpsTelemetryPort {
  report(evidence: OpsTelemetryEvidence): Promise<void>;
}

/** 占位实现：仅记录脱敏日志（ops 模块接入后替换） */
@Injectable()
export class LogOnlyOpsTelemetry implements OpsTelemetryPort {
  private readonly logger = new Logger(LogOnlyOpsTelemetry.name);

  async report(evidence: OpsTelemetryEvidence): Promise<void> {
    this.logger.warn(
      `ops 遥测（待接入 ops 模块）：event=${evidence.event}, ref=${evidence.ref}, reason=${evidence.reason}`,
    );
  }
}
