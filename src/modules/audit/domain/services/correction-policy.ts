/**
 * 纠错权限与客观错误判定（AUD-001/002/010）。
 *
 * - **客观错误**：对象写错、姓名/经历/时间地点错误、评语张冠李戴、违规内容；
 *   单纯不认同主观评价**不属于**事实错误（拒绝提交）；
 * - **作者回避**：原作者不得单独批准自己的错误（处理人 ≠ 作者）；
 * - **处理角色**：社团负责人/人事可处理本社团纠错；部门负责人不能处理活动
 *   结束后正式纠错；联合活动中某社团评分/评语/结论只能该社团负责人/人事/
 *   超管处理，其他社团只能看结果；联合排期等无单一作者共同事实可由任一
 *   参与社团负责人/人事处理；
 * - **驳回必填原因**。
 */
export const CLUB_LEADER_ROLE = 'CLUB_LEADER';
export const HR_ADMIN_ROLE = 'HR_ADMIN';
export const SUPER_ADMIN_ROLE = 'SUPER_ADMIN';

/** 无单一作者共同事实（联合排期等）：任一参与社团负责人/人事可处理（AUD-010） */
export const COMMON_FACT_OBJECT_TYPES: readonly string[] = ['JOINT_SCHEDULE'];

/** 无权异常（IFC-ERR-003 当前无权） */
export class CorrectionForbiddenError extends Error {
  constructor(message: string) {
    super(`IFC-ERR-003: ${message}`);
    this.name = 'CorrectionForbiddenError';
  }
}

/** 前置失败（IFC-ERR-005 输入无效 / IFC-ERR-006 业务前置失败） */
export class CorrectionPreconditionError extends Error {
  constructor(code: 'IFC-ERR-005' | 'IFC-ERR-006', message: string) {
    super(`${code}: ${message}`);
    this.name = 'CorrectionPreconditionError';
  }
}

/**
 * 纠错策略（纯规则）。
 */
export class CorrectionPolicy {
  /** 客观错误判定：主观评价争议 → 拒绝（IFC-ERR-006） */
  assertObjectiveError(description: string): void {
    // 仅当描述明确表达"单纯不认同/不喜欢主观评价"类异议时判定为主观争议；
    // 避免因出现"主观"等孤立词误伤客观纠错（如"该评语主观且有误，属客观事实"）。
    const subjective = /不认同|不认可|不喜欢|觉得不好|觉得不公平|评价不公|主观臆断/.test(
      description,
    );
    if (subjective) {
      throw new CorrectionPreconditionError('IFC-ERR-006', '单纯不认同主观评价不属于事实错误');
    }
  }

  /**
   * 作者回避：原作者不得单独批准自己的错误（AUD-001）。
   */
  assertNotSelfDecision(deciderId: string, authorId: string): void {
    if (deciderId === authorId) {
      throw new CorrectionForbiddenError('原作者不得单独批准自己的错误');
    }
  }

  /**
   * 处理人资格（AUD-010）：
   * - 本社团：负责人/人事可处理；
   * - 部门负责人不能处理活动结束后正式纠错；
   * - 联合活动中某社团评分/评语/结论：仅该社团负责人/人事/超管；
   *   其他社团只能看结果（决定命令拒绝）；
   * - 无单一作者共同事实（JOINT_SCHEDULE 等）：任一参与社团负责人/人事可处理。
   */
  assertCanDecide(
    decider: {
      principalId: string;
      roles: readonly string[];
      /** 当前社团（本社团处理） */
      clubId?: string;
    },
    target: { objectType: string; ownerClubId: string },
  ): void {
    if (decider.roles.includes(SUPER_ADMIN_ROLE)) {
      return;
    }
    const isHandler = decider.roles.some((r) => r === CLUB_LEADER_ROLE || r === HR_ADMIN_ROLE);
    if (!isHandler) {
      // 无负责人/人事处理角色（含仅部门负责人角色）不能处理正式纠错
      throw new CorrectionForbiddenError('仅社团负责人/人事可处理纠错');
    }
    // 无单一作者共同事实：任一参与社团负责人/人事可处理
    if (COMMON_FACT_OBJECT_TYPES.includes(target.objectType)) {
      return;
    }
    // 本社团记录：负责人/人事可处理
    if (decider.clubId !== undefined && decider.clubId === target.ownerClubId) {
      return;
    }
    throw new CorrectionForbiddenError('跨社团改写他人记录');
  }

  /** 驳回必填原因（IFC-ERR-005） */
  assertRejectionReason(reason: string): void {
    if (reason.trim().length === 0) {
      throw new CorrectionPreconditionError('IFC-ERR-005', '驳回必须填写原因');
    }
  }
}
