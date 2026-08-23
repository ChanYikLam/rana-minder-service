/**
 * 部门/职位关系状态机（SRS-SM-MEM-002 §8.2，IFC-SM-021）.
 *
 * 状态（SRS §9 状态机盘点）：无关系、变更处理中、当前有效、结束处理中、
 * 历史结束、同步异常。
 *
 * 8 条转换（SRS-状态机转换明细 §8.2 全表）：
 * R1. 无关系/历史结束 → 变更处理中：发起加入部门、任命职位或调岗（复合为单一业务命令）；
 * R2. 变更处理中 → 当前有效：Casdoor 写入并回读确认全部复合步骤；
 * R3. 变更处理中 → 无关系/历史结束 或 同步异常：外部失败或部分写入，补偿成功回原状态，
 *     补偿未确认转同步异常（最小权限）；
 * R4. 当前有效 → 结束处理中：发起退部、调动移出、辞职、免职或职位卸任；
 * R5. 结束处理中 → 历史结束：Casdoor 移除并回读确认；
 * R6. 结束处理中 → 当前有效：外部失败且回读确认原关系保持（执行失败恢复）；
 * R7. 无关系/当前有效/历史结束 → 当前有效/历史结束/同步异常：Casdoor 外部直接增删对账收口；
 * R8. 同步异常 → 无关系/当前有效/历史结束：人工通过正式 Casdoor 关系变更修复并对账收口。
 *
 * 核心不变量：
 * - 回读确认前不得进入当前有效（ORG-027；部分写入不得标当前有效）；
 * - 历史结束不覆盖：实际起止与历史事件只追加、不改写（MEM-013 同源约束）；
 * - 外部直接增删以 Casdoor 当前结果为准，不自动改回（MEM-016）；
 * - 同步异常只能经人工修复并以 Casdoor 当前值收口，禁止按历史一键重放（ORG-030/034）；
 * - 计划任期结束绝不驱动任何转换（MEM-010/012：无"到期自动卸任"出边）。
 */

export const DepartmentRelationStatus = {
  /** 无关系（从未建立，或变更补偿后回到无关系） */
  NO_RELATION: 'NO_RELATION',
  /** 变更处理中（加入部门/任命职位/调岗处理中；原关系继续有效 ORG-027） */
  CHANGE_PROCESSING: 'CHANGE_PROCESSING',
  /** 当前有效（回读确认后权限开放） */
  CURRENTLY_VALID: 'CURRENTLY_VALID',
  /** 结束处理中（退部/辞职/免职移除中；实际结束时间尚未填写） */
  END_PROCESSING: 'END_PROCESSING',
  /** 历史结束（移除回读确认；实际起止齐备，历史不可改写） */
  HISTORICAL_ENDED: 'HISTORICAL_ENDED',
  /** 同步异常（部分写入未补偿/外部非法状态/无法确认；冻结普通授权等待人工修复） */
  SYNC_ANOMALY: 'SYNC_ANOMALY',
} as const;

export type DepartmentRelationStatus =
  (typeof DepartmentRelationStatus)[keyof typeof DepartmentRelationStatus];

/** 转换非法异常（IFC-ERR-007 状态冲突） */
export class IllegalDepartmentRelationTransitionError extends Error {
  constructor(from: DepartmentRelationStatus, to: DepartmentRelationStatus) {
    super(`IFC-ERR-007: 非法部门/职位关系状态转换 ${from} -> ${to}`);
    this.name = 'IllegalDepartmentRelationTransitionError';
  }
}

/**
 * 转换规则（SRS-SM-MEM-002 §8.2 全部转换行；自环保留失败/重试标志语义）。
 * 终态口径：NO_RELATION 与 HISTORICAL_ENDED 可被新的业务命令/外部事件再次激活，
 * 因此不是绝对终态；SYNC_ANOMALY 只有 R8 人工修复一条出边。
 */
const TRANSITIONS: Readonly<Record<DepartmentRelationStatus, readonly DepartmentRelationStatus[]>> =
  {
    [DepartmentRelationStatus.NO_RELATION]: [
      DepartmentRelationStatus.CHANGE_PROCESSING, // R1 发起加入/任命
      DepartmentRelationStatus.CURRENTLY_VALID, // R7 外部直接加入（回读确认）
      DepartmentRelationStatus.HISTORICAL_ENDED, // R7 外部移除对账（无既有活跃段的收口落点）
      DepartmentRelationStatus.SYNC_ANOMALY, // R7 外部产生非法状态
      DepartmentRelationStatus.NO_RELATION, // 自环：R3 补偿成功后保持无关系（重复收口幂等）
    ],
    [DepartmentRelationStatus.CHANGE_PROCESSING]: [
      DepartmentRelationStatus.CURRENTLY_VALID, // R2 全部回读确认
      DepartmentRelationStatus.NO_RELATION, // R3 补偿成功且此前无关系
      DepartmentRelationStatus.HISTORICAL_ENDED, // R3 补偿成功且此前已历史结束（重任命失败回原状态）
      DepartmentRelationStatus.SYNC_ANOMALY, // R3 补偿未确认
      DepartmentRelationStatus.CHANGE_PROCESSING, // 自环：15 分钟内失败/重试标志
    ],
    [DepartmentRelationStatus.CURRENTLY_VALID]: [
      DepartmentRelationStatus.END_PROCESSING, // R4 发起退部/辞职/免职/调动移出
      DepartmentRelationStatus.HISTORICAL_ENDED, // R7 外部直接移除（回读确认）
      DepartmentRelationStatus.SYNC_ANOMALY, // R7 外部产生零负责人等非法状态
    ],
    [DepartmentRelationStatus.END_PROCESSING]: [
      DepartmentRelationStatus.HISTORICAL_ENDED, // R5 移除回读确认
      DepartmentRelationStatus.CURRENTLY_VALID, // R6 失败恢复（原关系确认完整）
      DepartmentRelationStatus.END_PROCESSING, // 自环：级联未全部确认，保持处理中
      DepartmentRelationStatus.SYNC_ANOMALY, // 无法确认原关系且补偿未收口
    ],
    [DepartmentRelationStatus.HISTORICAL_ENDED]: [
      DepartmentRelationStatus.CHANGE_PROCESSING, // R1 重新任命/再加入（新任期）
      DepartmentRelationStatus.CURRENTLY_VALID, // R7 外部直接重新加入
      DepartmentRelationStatus.SYNC_ANOMALY, // R7 外部产生非法状态
    ],
    // R8：同步异常仅可人工修复收口（按 Casdoor 回读实际值落定目标态）
    [DepartmentRelationStatus.SYNC_ANOMALY]: [
      DepartmentRelationStatus.NO_RELATION,
      DepartmentRelationStatus.CURRENTLY_VALID,
      DepartmentRelationStatus.HISTORICAL_ENDED,
    ],
  };

/** 部门/职位关系状态机（纯规则；SRS-SM-MEM-002） */
export class DepartmentRelationStateMachine {
  canTransition(from: DepartmentRelationStatus, to: DepartmentRelationStatus): boolean {
    const edges = TRANSITIONS[from];
    if (edges === undefined) return false; // 未知状态：一律不可转换（防御）
    return edges.includes(to);
  }

  /** 执行转换；非法转换抛 IllegalDepartmentRelationTransitionError */
  transition(
    from: DepartmentRelationStatus,
    to: DepartmentRelationStatus,
  ): DepartmentRelationStatus {
    if (!this.canTransition(from, to)) {
      throw new IllegalDepartmentRelationTransitionError(from, to);
    }
    return to;
  }
}
