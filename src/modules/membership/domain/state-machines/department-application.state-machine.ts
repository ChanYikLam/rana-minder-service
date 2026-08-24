/**
 * 部门关系申请状态机（SRS-SM-MEM-003 §8.3，IFC-SM-022）.
 *
 * 状态：待审批、已撤回、已驳回、已批准待执行、执行处理中、已生效、
 * 执行失败保持原关系。
 *
 * 8 条转换（SRS-状态机转换明细 §8.3 全表）：
 * A1. 新建 → 待审批：成员本人提交加入/退出/调动申请（目标部门有效、范围明确、
 *     无冲突待处理申请）；
 * A2. 待审批 → 已撤回：申请人本人二次确认撤回（与批准/驳回竞争只一个成功）；
 * A3. 待审批 → 已驳回：有权审批人驳回且原因必填（本人不能审批自己）；
 * A4. 待审批 → 已批准待执行：排除自审；关闭待审批撤回能力；
 * A5. 已批准待执行 → 执行处理中：启动 Casdoor 关系变更（跨部门调动整体执行，
 *     进入后不可按待审批撤回）；
 * A6. 执行处理中 → 已生效：加入/退出/调动的全部目标关系回读确认（调动不得半完成）；
 * A7. 执行处理中 → 执行失败保持原关系：自动重试结束且原关系回读完整；
 * A8. 执行失败保持原关系 → 执行处理中：人工重试（不重新审批，沿用原业务幂等键）；
 *     扩展：重试前回读发现目标已实际生效 → 直接收口到已生效。
 *
 * 核心不变量：
 * - 撤回能力在批准后关闭（A4 之后无 A2 出边）；
 * - 同一申请只生效一次；重复回调幂等；
 * - 失败保持原关系：当前关系不变并允许人工重试。
 */

export const DepartmentApplicationStatus = {
  /** 待审批 */
  PENDING_APPROVAL: 'PENDING_APPROVAL',
  /** 已撤回（终态） */
  WITHDRAWN: 'WITHDRAWN',
  /** 已驳回（终态；原因必填留痕） */
  REJECTED: 'REJECTED',
  /** 已批准待执行（撤回能力关闭） */
  APPROVED_PENDING_EXECUTION: 'APPROVED_PENDING_EXECUTION',
  /** 执行处理中 */
  EXECUTION_PROCESSING: 'EXECUTION_PROCESSING',
  /** 已生效（终态） */
  EFFECTIVE: 'EFFECTIVE',
  /** 执行失败保持原关系（允许人工重试） */
  EXEC_FAILED_ORIGINAL_PRESERVED: 'EXEC_FAILED_ORIGINAL_PRESERVED',
} as const;

export type DepartmentApplicationStatus =
  (typeof DepartmentApplicationStatus)[keyof typeof DepartmentApplicationStatus];

/** 转换非法异常（IFC-ERR-007 状态冲突） */
export class IllegalDepartmentApplicationTransitionError extends Error {
  constructor(from: DepartmentApplicationStatus, to: DepartmentApplicationStatus) {
    super(`IFC-ERR-007: 非法部门关系申请状态转换 ${from} -> ${to}`);
    this.name = 'IllegalDepartmentApplicationTransitionError';
  }
}

const TRANSITIONS: Readonly<
  Record<DepartmentApplicationStatus, readonly DepartmentApplicationStatus[]>
> = {
  [DepartmentApplicationStatus.PENDING_APPROVAL]: [
    DepartmentApplicationStatus.WITHDRAWN, // A2
    DepartmentApplicationStatus.REJECTED, // A3
    DepartmentApplicationStatus.APPROVED_PENDING_EXECUTION, // A4
  ],
  [DepartmentApplicationStatus.APPROVED_PENDING_EXECUTION]: [
    DepartmentApplicationStatus.EXECUTION_PROCESSING, // A5
  ],
  [DepartmentApplicationStatus.EXECUTION_PROCESSING]: [
    DepartmentApplicationStatus.EFFECTIVE, // A6
    DepartmentApplicationStatus.EXEC_FAILED_ORIGINAL_PRESERVED, // A7
    DepartmentApplicationStatus.EXECUTION_PROCESSING, // 自环：未全部确认保持执行处理中
  ],
  [DepartmentApplicationStatus.EXEC_FAILED_ORIGINAL_PRESERVED]: [
    DepartmentApplicationStatus.EXECUTION_PROCESSING, // A8 人工重试
    DepartmentApplicationStatus.EFFECTIVE, // A8 扩展：重试前回读发现已实际生效，直接收口
  ],
  [DepartmentApplicationStatus.WITHDRAWN]: [],
  [DepartmentApplicationStatus.REJECTED]: [],
  [DepartmentApplicationStatus.EFFECTIVE]: [],
};

/** 部门关系申请状态机（纯规则；SRS-SM-MEM-003） */
export class DepartmentApplicationStateMachine {
  canTransition(from: DepartmentApplicationStatus, to: DepartmentApplicationStatus): boolean {
    const edges = TRANSITIONS[from];
    if (edges === undefined) return false;
    return edges.includes(to);
  }

  transition(
    from: DepartmentApplicationStatus,
    to: DepartmentApplicationStatus,
  ): DepartmentApplicationStatus {
    if (!this.canTransition(from, to)) {
      throw new IllegalDepartmentApplicationTransitionError(from, to);
    }
    return to;
  }

  /** 待审批期间才可撤回（批准后关闭撤回能力 ORG-036） */
  canWithdraw(status: DepartmentApplicationStatus): boolean {
    return status === DepartmentApplicationStatus.PENDING_APPROVAL;
  }
}
