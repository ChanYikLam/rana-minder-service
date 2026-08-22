/**
 * 部门/职位关系策略（SRS-SM-MEM-002 前置规则；ORG-020~025、MEM-003/005/006/008~010、
 * MEM-010 任期建模）。
 *
 * 纯规则：不执行写入；用例层把结果并入前置校验并保证同一事务提交。
 * 角色数据一律由访问端口服务端重算传入（ORG-038：不信任前端角色）。
 */

import type {
  DepartmentRelation,
  PositionTenure,
  RelationKind,
} from '../models/department-relation';

export const REL_MEMBER_ROLE = 'MEMBER';
export const REL_DEPARTMENT_LEADER_ROLE = 'DEPARTMENT_LEADER';
export const REL_CLUB_LEADER_ROLE = 'CLUB_LEADER';
export const REL_HR_ADMIN_ROLE = 'HR_ADMIN';
export const REL_SUPER_ADMIN_ROLE = 'SUPER_ADMIN';

/** 无权异常（IFC-ERR-003 当前无权） */
export class RelationForbiddenError extends Error {
  constructor(message: string) {
    super(`IFC-ERR-003: ${message}`);
    this.name = 'RelationForbiddenError';
  }
}

/** 前置失败异常（IFC-ERR-006 业务前置条件失败） */
export class RelationPreconditionError extends Error {
  constructor(message: string) {
    super(`IFC-ERR-006: ${message}`);
    this.name = 'RelationPreconditionError';
  }
}

/** 状态冲突异常（IFC-ERR-007） */
export class RelationStateConflictError extends Error {
  constructor(message: string) {
    super(`IFC-ERR-007: ${message}`);
    this.name = 'RelationStateConflictError';
  }
}

/** 学年推导输入（CFG 配置：学年开始月份，默认 9 月） */
export interface AcademicYearConfig {
  /** 学年开始月份（1~12；如 9 表示 9 月开学） */
  readonly startMonth: number;
}

/**
 * 默认当前学年标签（MEM-010：任期默认当前学年）。
 * 例如 startMonth=9 时，2025-10-15 → "2025-2026"；2025-06-30 → "2024-2025"。
 */
export function academicYearOf(now: Date, config: AcademicYearConfig): string {
  const month = now.getMonth() + 1; // 1-based
  const year = now.getFullYear();
  const startYear = month >= config.startMonth ? year : year - 1;
  return `${startYear}-${startYear + 1}`;
}

/** 当前学年的计划结束时刻（学年结束月最后一天 23:59:59.999 本地时区） */
export function academicYearEndOf(now: Date, config: AcademicYearConfig): Date {
  const label = academicYearOf(now, config);
  const startYear = Number(label.split('-')[0]);
  const endMonth = config.startMonth === 1 ? 12 : config.startMonth - 1;
  const endYear = endMonth < config.startMonth ? startYear + 1 : startYear;
  return new Date(endYear, endMonth - 1 + 1, 0, 23, 59, 59, 999);
}

/** 变更发起上下文（用例层从端口重算后传入） */
export interface RelationChangeContext {
  /** 操作者在社团的当前有效角色集合 */
  readonly operatorRoles: readonly string[];
  /** 目标成员是否当前社团成员（MEM-001 CURRENT_MEMBER） */
  readonly subjectIsCurrentMember: boolean;
  /** 操作者是否为目标部门的部门负责人 */
  readonly operatorLeadsTargetDepartment: boolean;
  /** 目标是否负责人（会长团）职位——仅社团负责人可任命（ORG-021） */
  readonly targetIsLeaderPosition: boolean;
  /** 复合命令（组合任命/调岗）是否已获明确组合确认 */
  readonly compositeConfirmed: boolean;
  /** 撤销侧涉及的主体当前是否负责人（免职/调动移出负责人职位时须交接 ORG-024） */
  readonly subjectIsOwner: boolean;
  /** 同一操作中指定的继任者（最后负责人交接锚点；可为空） */
  readonly successors?: readonly string[];
  /** 超级管理员紧急处置豁免（ORG-024/029） */
  readonly emergencyBypass?: boolean;
}

/** 结束发起上下文 */
export interface RelationEndContext {
  readonly operatorRoles: readonly string[];
  /** 审批事实满足（退部需批准 / 辞职需上级批准 / 免职有权管理员决定） */
  readonly approvalSatisfied: boolean;
  readonly subjectIsOwner: boolean;
  readonly successors?: readonly string[];
  readonly emergencyBypass?: boolean;
}

/** 部门/职位关系策略（纯规则） */
export class RelationChangePolicy {
  /**
   * 变更发起权限门（R1 前置；ORG-020/021 层级）：
   * - 社团负责人/人事管理员：本社团全部普通关系；
   * - 部门负责人：仅本部门的普通职位与成员关系（P-MEM-04：部门负责人仅本部门普通职位）；
   * - 负责人（会长团）职位的任命/免职：仅社团负责人（人事不得平时任免负责人 ORG-021）。
   */
  assertCanStartChange(ctx: RelationChangeContext, kind: RelationKind): void {
    const roles = ctx.operatorRoles;
    const isClubLeader = roles.includes(REL_CLUB_LEADER_ROLE);
    const isHr = roles.includes(REL_HR_ADMIN_ROLE);
    const isDeptLeaderOfTarget = ctx.operatorLeadsTargetDepartment;

    if (!isClubLeader && !isHr && !isDeptLeaderOfTarget) {
      throw new RelationForbiddenError('无权对该成员发起部门/职位关系变更（ORG-020/021）');
    }
    if (kind === 'POSITION' && ctx.targetIsLeaderPosition && !isClubLeader) {
      throw new RelationForbiddenError('负责人职位任免仅社团负责人可操作（ORG-021）');
    }
    if (isDeptLeaderOfTarget && !isClubLeader && !isHr && ctx.targetIsLeaderPosition) {
      throw new RelationForbiddenError('部门负责人仅能管理本部门普通职位（ORG-021）');
    }
  }

  /** 目标必须是当前社团成员（非成员走组合任命入社路径 MEM-007，不在本命令范围） */
  assertSubjectIsMember(ctx: RelationChangeContext): void {
    if (!ctx.subjectIsCurrentMember) {
      throw new RelationPreconditionError(
        '目标不是当前社团成员；非成员任命须走组合入社路径（MEM-007）',
      );
    }
  }

  /** 复合调岗/加入部门＋任职必须明确组合确认后作为单一业务命令执行（MEM-007/009） */
  assertCompositeConfirmed(ctx: RelationChangeContext, composite: boolean): void {
    if (composite && !ctx.compositeConfirmed) {
      throw new RelationPreconditionError(
        '复合调岗/加入部门＋任职必须明确组合确认后整体提交（MEM-007/009）',
      );
    }
  }

  /** 最后负责人连续性（ORG-021~025）：撤销唯一负责人必须同命令指定继任者或超管紧急处置 */
  assertOwnerContinuityOnEnd(
    ctx: Pick<RelationEndContext, 'subjectIsOwner' | 'successors' | 'emergencyBypass'>,
  ): void {
    if (ctx.emergencyBypass === true) return;
    if (!ctx.subjectIsOwner) return;
    const successorGranted = (ctx.successors ?? []).some((id) => Boolean(id));
    if (!successorGranted) {
      throw new RelationPreconditionError(
        '撤销最后一名负责人必须同命令完成交接或由超级管理员紧急处置（ORG-021~025、IFC-ERR-006）',
      );
    }
  }

  /** 结束发起审批门（R4 前置：退部批准/辞职上级批准/免职有权决定） */
  assertEndApproval(ctx: RelationEndContext): void {
    if (!ctx.approvalSatisfied) {
      throw new RelationPreconditionError(
        '结束关系必须先满足对应审批/决定前置（MEM-003/005/006/008/009）',
      );
    }
  }

  /** 只撤销对应权限：结束收口不得误删其他关系（由用例以单段目标保证，此处防御断言） */
  assertSingleTargetScope(steps: readonly { kind: RelationKind; refId: string }[]): void {
    if (steps.length !== 1) {
      throw new RelationStateConflictError(
        '结束处理只允许针对单一目标关系段（不得误删其他关系，MEM-009）',
      );
    }
  }

  /**
   * 连任创建新任期（MEM-014）：新任期必须携带新的 planned 区间且不与既有任期 id 重复；
   * 旧任期数据不可变——本策略拒绝任何"延长旧任期 plannedEnd"式输入。
   */
  assertReappointmentCreatesNewTenure(
    existing: readonly PositionTenure[],
    next: PositionTenure,
  ): void {
    if (existing.some((t) => t.tenureId === next.tenureId)) {
      throw new RelationStateConflictError('任期 id 重复：连任必须创建独立新任期（MEM-014）');
    }
    const previous = existing[existing.length - 1];
    if (
      previous !== undefined &&
      previous.actualEndAt !== null &&
      Date.parse(next.plannedStartAt) < Date.parse(previous.actualEndAt)
    ) {
      throw new RelationPreconditionError(
        '新任期计划开始早于上一任期实际结束，禁止重叠任期（MEM-014）',
      );
    }
  }

  /** 计划时间只记录不驱动卸任（MEM-010/012）：拒绝把 plannedEnd 当作到期触发依据的调用 */
  assertNoAutoEndByPlannedSchedule(): void {
    throw new RelationStateConflictError(
      '计划任期结束到达不触发自动卸任或撤权（MEM-010/012），须走换届/辞职/免职等显式业务流程',
    );
  }

  /** 在任展示口径（MEM-012/014）：没有实际结束事件就仍在任，与计划时间无关 */
  isInOffice(relation: DepartmentRelation): boolean {
    return relation.status === ('CURRENTLY_VALID' as DepartmentRelation['status']);
  }
}
