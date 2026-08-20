/**
 * 应用启动状态与版本端口。
 *
 * 路径：src/platform/observability/status-page/（PR #32 §2.2 B）。
 *
 * 接口契约：
 * - snapshot(now)：返回 { version, startedAt, uptimeMs }。纯计算，不做 I/O，
 *   不读 DB / 不调适配器——状态页对"应用本身"的认知只来自进程事实。
 *
 * 默认实现 ProcessAppStatusPort：version 由构造器注入（首版从
 * process.env.npm_package_version 兜底；正式 version 来源在 1.5 配置骨架完
 * 善后由 RanaMinderConfig 注入）。startedAt 由 NestApplication bootstrap 完成
 * 时注入。
 *
 * 不替代 deploy/release 元数据：本端口只回答"当前进程"。
 */

export interface AppStatusSnapshot {
  readonly version: string;
  readonly startedAt: Date;
  readonly uptimeMs: number;
}

export interface AppStatusPort {
  snapshot(now: Date): AppStatusSnapshot;
}

export class ProcessAppStatusPort implements AppStatusPort {
  constructor(
    private readonly version: string,
    private readonly startedAt: Date,
  ) {}

  snapshot(now: Date): AppStatusSnapshot {
    return {
      version: this.version,
      startedAt: this.startedAt,
      uptimeMs: Math.max(0, now.getTime() - this.startedAt.getTime()),
    };
  }
}
