/**
 * observability/log-storage 端口——结构化日志的持久化与查询接口。
 *
 * 路径：src/platform/observability/infrastructure/（PR #32 §2.2 B）。
 *
 * 接口契约：
 * - write(tier, rawRecord, sanitizedRecord)：落档；调用方传入脱敏前后两份记录，
 *   存储层按需选择落哪一份（首版推荐落 sanitized；如需审计回溯，由 audit 模块
 *   独立写，**不**通过本端口）。
 * - queryByTraceId(traceId, limit)：按追踪编号拉日志；返回的是**已脱敏**的
 *   记录（写入侧已脱敏 + 读侧再脱敏，防御双层）。
 *
 * 不做的事：
 * - 业务审计（AUD-*）——边界由 audit-link/audit-boundary 与 audit 模块守护；
 * - 跨进程/跨 HTTP 追踪上下文恢复（HTTP 入口由 HTTP 适配层在 worker bootstrap
 *   接入）。
 *
 * 首版桩 NotWiredLogStoragePort：未连接真实存储时 write 为 no-op、查询返回
 * 空。真实实现在 src/platform/observability/infrastructure/LogStorageAdapter
 * （7️⃣+ 阶段）补齐——可挂 Loki / ELK / 文件归档。
 */

import type { LogTier } from '../domain/services/retention.rules';
import type { LogRecord } from '../logging/sanitizer';

export interface LogStoragePort {
  write(tier: LogTier, rawRecord: LogRecord, sanitizedRecord: LogRecord): Promise<void>;
  queryByTraceId(traceId: string, limit: number): Promise<readonly LogRecord[]>;
}

export class NotWiredLogStoragePort implements LogStoragePort {
  async write(_tier: LogTier, _rawRecord: LogRecord, _sanitizedRecord: LogRecord): Promise<void> {
    // 未连接真实存储：no-op；LogWriterAdapter 仍会镜像到 NestJS Logger（stdout）。
  }

  async queryByTraceId(_traceId: string, _limit: number): Promise<readonly LogRecord[]> {
    return [];
  }
}
