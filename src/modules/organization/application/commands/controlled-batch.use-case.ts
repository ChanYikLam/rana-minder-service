/**
 * ORG-004 受控批量操作用例（SRS-SM-ORG-004）。
 *
 * 仍属平台模块能力的轻量包装：状态机驱动 + 领域不变量守卫 +
 * 批次部分成功逆序补偿。平台侧 batch 执行器经 ControlledBatchPort 进入，
 * 逐阶段调用本用例推进批次状态机；逐项执行与重试关联在平台模块落地
 * （ORG-040），本用例负责把"业务级"约束钉在状态机驱动之外：
 *
 * - 部分成功逆序补偿（ORG-034 关联）：若批次项声明 `requiresCompensation=true`，
 *   出现 partial_success 时按登记的 stepOrder 逆序调用关系命令补偿
 *   （RelationCommandStateMachine.partial_write / compensation_confirmed）。
 * - 最后负责人连续性守卫（ORG-024）：批次确认前若触及负责人 Group，须同
 *   操作指定继任者或显式声明 emergencyBypass（ORG-028 紧急停用豁免）。
 * - 已知事件校验：仅放行状态机 8 条转换对应的事件名，未知事件直接拒绝。
 */

import {
  ControlledBatchStateMachine,
  type BatchEvent,
  type BatchItemResult,
} from '../../domain/state-machines/controlled-batch.state-machine';
import type { ControlledBatchStatus } from '../../domain/types';
import { orgError } from '../../domain/types';
import { LastOwnerContinuityPolicy } from '../../domain/services/last-owner-continuity.policy';
import { CONTROLLED_BATCH_PORT, type ControlledBatchPort } from '../ports';

export interface BatchPhaseInput {
  batchId: string;
  event: BatchEventName;
  status: ControlledBatchStatus;
  facts: {
    scopeFixed?: boolean;
    previewFresh?: boolean;
    inputsFrozen?: boolean;
    operatorAuthorized?: boolean;
    items?: BatchItemResult[];
    retryItems?: BatchItemResult[];
  };
}

export type BatchEventName = BatchEvent;

/** 批次中需要逆序补偿的项（ORG-034：复合关系写入部分失败） */
export interface BatchCompensationItem {
  readonly itemId: string;
  readonly stepOrder: number;
  readonly compensate: () => Promise<void>;
}

/**
 * 逆序补偿的合法入口状态（ORG-034）：仅部分成功 / 失败项重试中允许回滚，
 * 其余状态（all_succeeded / all_failed / selecting 等）不具备可补偿语义。
 */
export const COMPENSABLE_BATCH_STATUSES: ReadonlySet<ControlledBatchStatus> =
  new Set<ControlledBatchStatus>(['partial_success', 'failed_items_retrying']);

/** 确认批次前的负责人守卫上下文 */
export interface BatchOwnerGuardContext {
  readonly clubName: string;
  readonly currentOwnerIds: readonly string[];
  readonly revokingSubjectIds: readonly string[];
  readonly successorIds: readonly string[];
  /** ORG-028 强停豁免：紧急停用场景允许暂时无负责人 */
  readonly emergencyBypass?: boolean;
}

export class ControlledBatchUseCase {
  private readonly stateMachine = new ControlledBatchStateMachine();

  constructor(private readonly platformPort: ControlledBatchPort) {}

  /**
   * 状态机阶段驱动：仅放行 8 条已知事件，调用平台端口执行并返回新状态。
   * 平台侧负责实际批次的筛选、冻结输入、逐项执行与重试关联（ORG-040）。
   */
  async drive(input: BatchPhaseInput): Promise<ControlledBatchStatus> {
    if (!ControlledBatchStateMachine.knownEvents().has(input.event)) {
      throw orgError.validation(`未知批次事件 ${input.event}`);
    }
    const result = this.stateMachine.transition({
      status: input.status,
      event: input.event,
      facts: input.facts,
    });
    // 把状态机声明的副作用标签交给平台端口消费（save_preview_audit、freeze_batch_inputs、
    // spawn_item_tasks 等），保证驱动阶段与副作用落地一致。
    await this.platformPort.execute(input.batchId, input.event, result.requiredSideEffects);
    return result.status;
  }

  /**
   * 批次部分成功逆序补偿（ORG-034 关联）。
   *
   * 仅当批次处于 partial_success / failed_items_retrying 才允许补偿（可经 opts.status 显式门槛）；
   * 按 stepOrder 降序执行，确保"先补偿后置步骤、再补偿前置步骤"，避免回退顺序错误导致部分关系泄漏。
   *
   * 幂等/恢复语义：
   * - stepOrder 必须可严格区分先后，重复会抛校验错（避免"逆序"退化为声明序）。
   * - 单项补偿失败不阻断后续（继续回退到最早项以缩小影响面），但会进入 failed。
   * - 返回轨迹含 fullyCompensated：若为 false，调用方不得重复调用本方法（会重复补偿已成功项），
   *   应依据 failed 轨迹进入人工介入 / compensation_confirmed 收口。
   */
  async compensateInReverseOrder(
    items: readonly BatchCompensationItem[],
    opts?: { status?: ControlledBatchStatus },
  ): Promise<{
    compensated: string[];
    failed: Array<{ itemId: string; error: string }>;
    fullyCompensated: boolean;
  }> {
    if (opts?.status !== undefined && !COMPENSABLE_BATCH_STATUSES.has(opts.status)) {
      throw orgError.stateConflict(
        `批次状态 ${opts.status} 不允许逆序补偿，仅 ${[...COMPENSABLE_BATCH_STATUSES].join(
          '/',
        )} 可补偿（ORG-034）`,
      );
    }
    if (items.length === 0) {
      return { compensated: [], failed: [], fullyCompensated: true };
    }
    // stepOrder 唯一性：逆序补偿语义要求能严格区分先后
    const seenOrder = new Set<number>();
    for (const item of items) {
      if (seenOrder.has(item.stepOrder)) {
        throw orgError.validation(
          `批次补偿项 stepOrder=${item.stepOrder} 重复，无法确定逆序（ORG-034）`,
        );
      }
      seenOrder.add(item.stepOrder);
    }
    // 逆序：stepOrder 大的先补偿（执行顺序中靠后的先撤销）
    const ordered = [...items].sort((a, b) => b.stepOrder - a.stepOrder);
    const compensated: string[] = [];
    const failed: Array<{ itemId: string; error: string }> = [];
    for (const item of ordered) {
      try {
        await item.compensate();
        compensated.push(item.itemId);
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        failed.push({ itemId: item.itemId, error });
        // 单项补偿失败不阻断后续补偿（继续回退到最早项以缩小影响面）
      }
    }
    return { compensated, failed, fullyCompensated: failed.length === 0 };
  }

  /**
   * 接入最后负责人连续性守卫（ORG-024）。
   * 确认批次前必须确保：撤销后（含同一操作授予的继任者）不会产生零负责人窗口
   * （除非 emergencyBypass）。
   */
  assertMaintainsLastOwner(ctx: BatchOwnerGuardContext): void {
    // 投影为正确性主校验："批次（含撤销 + 继任授予）执行后"的最终剩余负责人必须非空。
    // 撤销最后一名负责人必须同操作指定继任者，否则投影结果为空即被拒绝（IFC-ERR-006）。
    // 相比逐项 assertNoZeroOwnerWindow（并行假设、与顺序累积语义不完全一致），
    // 投影一次性覆盖"多个撤销者 + 继任授予"的最终结果，语义更贴近实际撤销序列。
    const projected = this.projectOwnersAfterBatch(ctx);
    LastOwnerContinuityPolicy.assertClubHasOwner(
      projected,
      ctx.clubName,
      ctx.emergencyBypass === true,
    );
  }

  /**
   * 工具：算出"本批次（含撤销 + 继任授予）执行后"的最终负责人集合。
   * 逻辑：先去掉 revokingSubjectIds，再加上 successorIds（去重）。
   */
  private projectOwnersAfterBatch(ctx: BatchOwnerGuardContext): readonly string[] {
    const revoking = new Set(ctx.revokingSubjectIds);
    const next = new Set<string>();
    for (const id of ctx.currentOwnerIds) {
      if (!revoking.has(id)) next.add(id);
    }
    for (const id of ctx.successorIds) {
      next.add(id);
    }
    return [...next];
  }
}

export const controlledBatchProvider = {
  provide: CONTROLLED_BATCH_PORT,
  useFactory: (/** 平台 batch 执行器接入点（本次为桩） */) => ({
    async execute(_batchId: string, _phase: string): Promise<{ ok: boolean }> {
      return { ok: true };
    },
  }),
};
