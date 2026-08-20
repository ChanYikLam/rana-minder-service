/**
 * 数据库连通性端口。
 *
 * 路径：src/platform/observability/status-page/（PR #32 §2.2 B）。
 *
 * 接口契约：
 * - ping()：返回 { ok:true, latencyMs } 或 { ok:false, error }。要求不抛异常，
 *   出错即降级为 ok=false（ADR-011：状态页不向用户暴露内部异常）。
 *
 * 首版桩实现 NotWiredDbStatusPort：未连接 src/database/ 时返回 ok=false +
 * 'db-status port not wired (DEP-Q-001 pending)'。状态页展示端会把这条降级
 * 结果显式标注为"未知"。
 *
 * 真实实现在 src/database/ 接入后由 useClass 替换；本 MR 不引入 sql/pg/orm
 * 任何依赖（DEP-Q-001 锁定）。
 */

export type DbPingResult =
  | { readonly ok: true; readonly latencyMs: number }
  | { readonly ok: false; readonly error: string };

export interface DbStatusPort {
  ping(): Promise<DbPingResult>;
}

export class NotWiredDbStatusPort implements DbStatusPort {
  async ping(): Promise<DbPingResult> {
    return { ok: false, error: 'db-status port not wired (DEP-Q-001 pending)' };
  }
}
