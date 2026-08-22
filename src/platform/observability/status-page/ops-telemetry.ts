/**
 * Ops 运维可观测（T7）——数据库连通经 OpsTelemetry 汇入脱敏日志。
 *
 * 依据 ADR-011：
 * - 把「数据库连通最近结果与时间」经 OpsTelemetry 汇入运维脱敏日志（只读探测，
 *   不写业务数据、不改任何状态，ADR-011 §2.1）；
 * - 外部依赖（Casdoor/邮件/文件检查/通知/备份）最近结果由 T3 真实适配器经
 *   DepLatestPort 汇入状态页；本模块的 DB 连通部分先行接入。
 *
 * 实现：对 DbStatusPort 做周期/按需 ping，把 { ok, latencyMs|error, checkedAt }
 * 作为 ops 事件写入 SecurityLogger（写入前脱敏，最小披露）。
 */

import type { DbStatusPort, DbPingResult } from './db-status';

/** Ops 运维可观测 DI 标识符（T7）。 */
export const OPS_TELEMETRY = 'OBSERVABILITY_OPS_TELEMETRY';

export interface OpsLoggerLike {
  warn(record: Record<string, unknown>): void;
  error(record: Record<string, unknown>): void;
}

export interface OpsTelemetry {
  /** 执行一次 DB 连通探测并将结果写入脱敏 ops 日志。返回探测结果。 */
  reportDbConnectivity(): Promise<DbPingResult>;
}

export class NestOpsTelemetry implements OpsTelemetry {
  constructor(
    private readonly db: DbStatusPort,
    private readonly logger: OpsLoggerLike,
  ) {}

  async reportDbConnectivity(): Promise<DbPingResult> {
    const result = await this.db.ping();
    const record: Record<string, unknown> = {
      event: 'ops.db_connectivity',
      checkedAt: new Date().toISOString(),
      source: 'database',
    };
    if (result.ok) {
      record.ok = true;
      record.latencyMs = result.latencyMs;
      this.logger.warn({ ...record, kind: 'healthy' });
    } else {
      record.ok = false;
      // 最小披露：仅记录错误类别，不暴露连接串/内部堆栈。
      record.error = result.error;
      this.logger.error({ ...record, kind: 'degraded' });
    }
    return result;
  }
}
