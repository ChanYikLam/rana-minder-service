/**
 * 导出任务状态机（SRS-SM-EXP-001，IFC-SM-029）。
 *
 * 权威明细：docs/specification/SRS-状态机转换明细-v1.0.md §10.3（10 条转换）。
 *
 * 状态机链路：
 *   新建（NEW）→ 待生成（PENDING_GENERATION）→ 生成中（GENERATING）
 *     → 可下载（DOWNLOADABLE） / 失败（FAILED）
 *   失败 → 待生成/生成中（重试沿用原快照，范围变化需新申请）
 *   待生成/生成中/可下载 → 已失权（REVOKED）/ 已过期（EXPIRED）
 *   待生成/失败/可下载 → 已提前删除（PRE_DELETED）
 *   任一非删除状态命中正式删除清单 → 已提前删除（EXP-003、AUD-009）
 *
 * 核心不变量（EXP-001~003、GOV-004、NFR-003、JNT-023）：
 * - 生成成功前不得可下载；生成失败不得假成功（不得返回可下载或假成功）；
 * - 重试沿用原申请快照，不更换数据快照；范围变化需新申请；
 * - 失权/过期后不得继续生成或下载，已签发短链撤销；
 * - 下载为 DOWNLOADABLE 自环：只签发短时下载地址并记录下载，不改变快照或到期时间；
 * - 正式删除命中导出内容 → 未过期导出失效并清理，不得因导出快照绕过正式删除（AUD-009）。
 */

/** 导出任务状态（SRS-SM-EXP-001） */
export const ExportTaskStatus = {
  /** 新建（申请创建；任务与快照同事务落库） */
  NEW: 'NEW',
  /** 待生成（等待系统导出任务领取） */
  PENDING_GENERATION: 'PENDING_GENERATION',
  /** 生成中（单任务租约持有） */
  GENERATING: 'GENERATING',
  /** 可下载（生成完成，24h 内可下载） */
  DOWNLOADABLE: 'DOWNLOADABLE',
  /** 失败（可重试；沿用原快照） */
  FAILED: 'FAILED',
  /** 已失权（操作者失权/社团停用/联合授权失效） */
  REVOKED: 'REVOKED',
  /** 已过期（到达导出有效期） */
  EXPIRED: 'EXPIRED',
  /** 已提前删除（申请人提前删除或正式删除命中） */
  PRE_DELETED: 'PRE_DELETED',
} as const;

export type ExportTaskStatus = (typeof ExportTaskStatus)[keyof typeof ExportTaskStatus];

/** 导出任务事件（对应 SRS-SM-EXP-001 转换行） */
export type ExportTaskEvent =
  | 'apply' // 转换 1：申请异步导出
  | 'start_generation' // 转换 2：开始生成
  | 'generation_succeeded' // 转换 3：生成成功
  | 'generation_failed' // 转换 4：后台或存储失败
  | 'retry_generation' // 转换 5：重试生成（待生成或生成中）
  | 'revoke' // 转换 6：操作者失权/社团停用/联合授权失效
  | 'download' // 转换 7：下载导出文件（自环）
  | 'expire' // 转换 8：到达导出有效期
  | 'pre_delete' // 转换 9：申请人提前删除
  | 'formal_delete_hit'; // 转换 10：正式数据删除命中导出内容

/** 终态：失权/过期/提前删除（不可再推进业务） */
export const TERMINAL_STATUSES: readonly ExportTaskStatus[] = [
  ExportTaskStatus.REVOKED,
  ExportTaskStatus.EXPIRED,
  ExportTaskStatus.PRE_DELETED,
];

/**
 * 转换表：事件 → 允许的源状态（SRS-SM-EXP-001 §10.3 逐行）。
 * 与 club-onboarding 的 TABLE 结构一致，便于"每个事件声明了允许的源状态"测试。
 */
export const EXPORT_TRANSITION_TABLE: Readonly<
  Record<ExportTaskEvent, readonly ExportTaskStatus[]>
> = {
  apply: [ExportTaskStatus.NEW],
  start_generation: [ExportTaskStatus.PENDING_GENERATION],
  generation_succeeded: [ExportTaskStatus.GENERATING],
  generation_failed: [ExportTaskStatus.GENERATING],
  retry_generation: [ExportTaskStatus.FAILED],
  revoke: [
    ExportTaskStatus.PENDING_GENERATION,
    ExportTaskStatus.GENERATING,
    ExportTaskStatus.DOWNLOADABLE,
  ],
  download: [ExportTaskStatus.DOWNLOADABLE],
  expire: [
    ExportTaskStatus.PENDING_GENERATION,
    ExportTaskStatus.GENERATING,
    ExportTaskStatus.DOWNLOADABLE,
  ],
  pre_delete: [
    ExportTaskStatus.PENDING_GENERATION,
    ExportTaskStatus.FAILED,
    ExportTaskStatus.DOWNLOADABLE,
  ],
  formal_delete_hit: [
    ExportTaskStatus.NEW,
    ExportTaskStatus.PENDING_GENERATION,
    ExportTaskStatus.GENERATING,
    ExportTaskStatus.DOWNLOADABLE,
    ExportTaskStatus.FAILED,
    ExportTaskStatus.REVOKED,
    ExportTaskStatus.EXPIRED,
  ],
};

/** 确定性事件的目标状态（retry_generation 可显式指定目标，见类方法） */
const EVENT_TARGET: Readonly<Record<ExportTaskEvent, ExportTaskStatus>> = {
  apply: ExportTaskStatus.PENDING_GENERATION,
  start_generation: ExportTaskStatus.GENERATING,
  generation_succeeded: ExportTaskStatus.DOWNLOADABLE,
  generation_failed: ExportTaskStatus.FAILED,
  retry_generation: ExportTaskStatus.PENDING_GENERATION, // 默认回待生成
  revoke: ExportTaskStatus.REVOKED,
  download: ExportTaskStatus.DOWNLOADABLE, // 自环
  expire: ExportTaskStatus.EXPIRED,
  pre_delete: ExportTaskStatus.PRE_DELETED,
  formal_delete_hit: ExportTaskStatus.PRE_DELETED,
};

/** 重试允许的目标（SRS-SM-EXP-001 转换 5：待生成或生成中） */
const RETRY_TARGETS: readonly ExportTaskStatus[] = [
  ExportTaskStatus.PENDING_GENERATION,
  ExportTaskStatus.GENERATING,
];

/** 非法转换异常（IFC-ERR-007 状态冲突） */
export class IllegalExportTaskTransitionError extends Error {
  constructor(from: ExportTaskStatus, event: ExportTaskEvent, message?: string) {
    super(message ?? `IFC-ERR-007: 非法导出任务转换 ${from} --${event}--> ?`);
    this.name = 'IllegalExportTaskTransitionError';
  }
}

/** 导出任务状态机（纯规则；SRS-SM-EXP-001） */
export class ExportTaskStateMachine {
  /** 事件是否允许作用于该源状态 */
  canApply(from: ExportTaskStatus, event: ExportTaskEvent): boolean {
    return EXPORT_TRANSITION_TABLE[event].includes(from);
  }

  /**
   * 执行转换；非法转换抛 IllegalExportTaskTransitionError。
   *
   * @param opts.target 仅 retry_generation 允许显式指定
   *   （PENDING_GENERATION 或 GENERATING）；其余事件目标固定。
   */
  transition(
    from: ExportTaskStatus,
    event: ExportTaskEvent,
    opts?: { target?: ExportTaskStatus },
  ): ExportTaskStatus {
    if (!this.canApply(from, event)) {
      throw new IllegalExportTaskTransitionError(
        from,
        event,
        `IFC-ERR-007: 非法导出任务转换 ${from} --${event}--> 不允许`,
      );
    }

    if (event === 'retry_generation') {
      const target = opts?.target ?? ExportTaskStatus.PENDING_GENERATION;
      if (!RETRY_TARGETS.includes(target)) {
        throw new IllegalExportTaskTransitionError(
          from,
          event,
          `IFC-ERR-005: 重试目标非法：${target}（仅 PENDING_GENERATION / GENERATING）`,
        );
      }
      return target;
    }

    return EVENT_TARGET[event];
  }

  /** 终态判定（失权/过期/提前删除；失败可重试、可下载可撤销，均非终态） */
  isTerminal(status: ExportTaskStatus): boolean {
    return TERMINAL_STATUSES.includes(status);
  }

  /** 可下载判定：仅 DOWNLOADABLE 允许签发下载（下载每次实时重验） */
  canDownload(status: ExportTaskStatus): boolean {
    return status === ExportTaskStatus.DOWNLOADABLE;
  }
}
