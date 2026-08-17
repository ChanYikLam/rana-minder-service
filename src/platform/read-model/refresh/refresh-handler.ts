import { Inject, Injectable } from '@nestjs/common';
import type { RecomputeIntent } from '../contracts';
import { ProjectionType } from '../contracts';
import { OPS_TELEMETRY_PORT } from '../contracts/ops-telemetry-port';
import type { OpsTelemetryPort } from '../contracts/ops-telemetry-port';
import { ProjectionRegistry } from '../projection/projection-registry';
import { PROJECTION_STORE } from '../projection/projection-store';
import type { ProjectionStore } from '../projection/projection-store';

/**
 * 派生刷新处理器（refresh/）：消费"A 的 recompute"（RecomputeIntent）。
 *
 * 权威对象 A 变更产生重算意图；job 模块"派生重算"任务
 * （DerivedRebuildHandler，IFC-TX-008）领取后调用本处理器执行投影刷新/重建。
 *
 * 不变量：
 * - 旧水位不覆盖新结果：已消费更高源版本时跳过；
 * - 源对象不存在/已删除 → 标记失效而非伪造（IFC-QRY-009.9）；
 * - 派生失败不改源业务（IFC-TX-008），异常上抛由 job 记为可重试失败，
 *   同时经 ops 遥测上报技术证据（C5.3，脱敏日志/内置状态）；
 * - 幂等：intentId 复用同一任务重试时结果收敛。
 */
@Injectable()
export class RefreshHandler {
  constructor(
    private readonly registry: ProjectionRegistry,
    @Inject(PROJECTION_STORE) private readonly store: ProjectionStore,
    @Inject(OPS_TELEMETRY_PORT) private readonly ops: OpsTelemetryPort,
  ) {}

  async consume(intent: RecomputeIntent): Promise<void> {
    const targets: readonly ProjectionType[] = intent.targetProjections ?? this.allRegisteredTypes();
    for (const projectionType of targets) {
      await this.refreshOne(projectionType, intent);
    }
  }

  private async refreshOne(projectionType: ProjectionType, intent: RecomputeIntent): Promise<void> {
    try {
      await this.refreshInner(projectionType, intent);
    } catch (error) {
      // C5.3：重建失败技术证据进入 ops 脱敏日志/内置状态；仍上抛由 job 记为可重试失败
      await this.ops.report({
        event: 'REBUILD_FAILED',
        ref: `${projectionType}:${intent.source.objectType}:${intent.source.objectId}`,
        reason: error instanceof Error ? error.message : 'unknown',
        occurredAt: new Date().toISOString(),
      });
      throw error;
    }
  }

  private async refreshInner(projectionType: ProjectionType, intent: RecomputeIntent): Promise<void> {
    const builder = this.registry.get(projectionType);
    const scope = intent.source.scope;

    // 旧水位不覆盖新结果：现有水位已消费 ≥ 源版本时跳过
    const existing = await this.store.load(projectionType, scope);
    if (existing !== null && existing.watermark.sourceVersion >= intent.source.version) {
      return;
    }

    const rebuilt = await builder.rebuild(scope, {
      expectedSourceVersion: intent.source.version,
      reason: intent.intentId,
      requestedAt: intent.createdAt,
    });

    if (rebuilt === null) {
      // 源不存在/已删除：标记失效，不伪造新鲜结果
      await this.store.invalidate(projectionType, scope, intent.createdAt, intent.intentId);
      return;
    }

    // 并发安全：保存前再次确认水位不落后（不覆盖更新结果）
    const latest = await this.store.load(projectionType, scope);
    if (latest !== null && latest.watermark.sourceVersion > intent.source.version) {
      return;
    }
    await this.store.save(rebuilt);
  }

  private allRegisteredTypes(): readonly ProjectionType[] {
    return this.registry.list().map((builder) => builder.projectionType);
  }
}
