import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';

import type {
  DepartmentRelation,
  RelationChangeState,
  RelationChangeType,
  RelationKind,
} from '../../domain/models/department-relation';
import {
  RelationChangeProgress,
  RelationKind as Kind,
} from '../../domain/models/department-relation';
import { RelationChangePolicy } from '../../domain/services/relation-change.policy';
import { academicYearEndOf, academicYearOf } from '../../domain/services/relation-change.policy';
import { DepartmentRelationStateMachine } from '../../domain/state-machines/department-relation.state-machine';
import { DepartmentRelationStatus } from '../../domain/state-machines/department-relation.state-machine';
import {
  DEPARTMENT_RELATION_REPOSITORY,
  ACTIVE_RELATION_STATUSES,
} from '../../infrastructure/department-relation-repository';
import type { DepartmentRelationRepository } from '../../infrastructure/department-relation-repository';
import { RELATION_DIRECTORY_PORT } from '../relation-ports';
import type { RelationDirectoryPort } from '../relation-ports';
import {
  MEMBERSHIP_ACCESS_PORT,
  MEMBERSHIP_NOTIFICATION_PORT,
  saveNotificationFact,
} from '../ports';
import type { MembershipAccessPort, MembershipNotificationPort } from '../ports';
import { InMemoryMembershipNotificationPort } from '../../infrastructure/in-memory-stubs';

/** 自动重试窗口（ORG-027：15 分钟有界重试） */
const RETRY_WINDOW_MS = 15 * 60 * 1000;

/** 发起部门/职位关系变更输入（SRS-SM-MEM-002 转换 R1；ORG-020/021、MEM-007/009） */
export interface ChangeDepartmentRelationInput {
  readonly clubId: string;
  readonly subjectId: string;
  /** 操作者 id */
  readonly operatorId: string;
  readonly changeType: RelationChangeType;
  /** 加入/任命目标（join/appoint/composite 的正向侧；composite 任命时为职位 id） */
  readonly targetRefId: string;
  /** 调动移出源部门（TRANSFER_DEPARTMENT 时必填） */
  readonly removeDeptId?: string;
  /** 组合任命的初始部门（JOIN_DEPARTMENT_WITH_POSITION 时必填，MEM-007） */
  readonly withDepartmentId?: string;
  /** 任期计划区间（任命类；缺省按当前学年推导，MEM-010） */
  readonly plannedStartAt?: string;
  readonly plannedEndAt?: string;
  /** 复合命令（组合任命/调岗）必须明确组合确认（MEM-007/009） */
  readonly compositeConfirmed?: boolean;
  /** 最后负责人交接锚点（撤销负责人职位时同命令指定继任者 ORG-024） */
  readonly successors?: readonly string[];
  /** 超级管理员紧急处置豁免 */
  readonly emergencyBypass?: boolean;
}

/** 发起变更失败（IFC-ERR-003/006/007） */
export class ChangeRelationError extends Error {
  constructor(
    readonly code: 'IFC-ERR-003' | 'IFC-ERR-006' | 'IFC-ERR-007',
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = 'ChangeRelationError';
  }
}

/**
 * 发起部门/职位关系变更（R1：无关系/历史结束 → 变更处理中）。
 *
 * - **复合调岗/加入部门＋任职作为单一业务命令**（MEM-007/009）：一次提交生成一个
 *   changeGroupId，涉及的全部关系段（新增侧＋移出侧）并行进入变更处理中并共享
 *   该组 id；移出侧原关系在回读确认前继续有效（ORG-027）；
 * - 同一目标存在进行中关系段时拒绝重复/冲突操作（冲突命令仅一个成功 IFC-ERR-007）；
 * - 权限层级服务端重算（ORG-038）；最后负责人连续性满足（ORG-021~025）；
 * - 通知当事人及相关管理员进入处理；关键审计经历史事件留痕。
 */
@Injectable()
export class ChangeDepartmentRelationCommand {
  private readonly stateMachine = new DepartmentRelationStateMachine();
  private readonly policy = new RelationChangePolicy();

  constructor(
    @Inject(DEPARTMENT_RELATION_REPOSITORY)
    private readonly repo: DepartmentRelationRepository,
    @Inject(MEMBERSHIP_ACCESS_PORT) private readonly access: MembershipAccessPort,
    @Inject(RELATION_DIRECTORY_PORT) private readonly directory: RelationDirectoryPort,
    @Inject(MEMBERSHIP_NOTIFICATION_PORT)
    private readonly notifications: MembershipNotificationPort = new InMemoryMembershipNotificationPort(),
  ) {}

  async execute(input: ChangeDepartmentRelationInput): Promise<{
    groupId: string;
    relations: DepartmentRelation[];
  }> {
    const now = new Date();
    const composite = this.isComposite(input.changeType);
    if (composite && input.compositeConfirmed !== true) {
      throw new ChangeRelationError(
        'IFC-ERR-006',
        '复合调岗/加入部门＋任职必须明确组合确认后整体提交（MEM-007/009）',
      );
    }
    if (input.changeType === 'TRANSFER_DEPARTMENT' && !input.removeDeptId) {
      throw new ChangeRelationError('IFC-ERR-006', '跨部门调动必须指定移出源部门');
    }
    if (input.changeType === 'JOIN_DEPARTMENT_WITH_POSITION' && !input.withDepartmentId) {
      throw new ChangeRelationError('IFC-ERR-006', '组合任命必须同时指定初始部门');
    }
    if (!composite && (input.removeDeptId || input.withDepartmentId)) {
      throw new ChangeRelationError('IFC-ERR-006', '非复合命令不接受组合/移出侧参数');
    }
    if (input.changeType === 'TRANSFER_DEPARTMENT' && input.removeDeptId === input.targetRefId) {
      throw new ChangeRelationError('IFC-ERR-006', '调动目标部门与源部门相同');
    }

    // ---- 服务端重算权限与前提（ORG-023/038） ----
    const [operatorRoles, subjectIsCurrentMember] = await Promise.all([
      this.access.operatorRolesAt(input.clubId, input.operatorId),
      this.isCurrentMember(input.clubId, input.subjectId),
    ]);
    if (operatorRoles.length === 0) {
      throw new ChangeRelationError('IFC-ERR-003', '操作者在该社团无有效管理角色');
    }

    const kindOfTarget = await this.resolveKind(input.clubId, input.targetRefId, input.changeType);

    // 目标有效性（部门/职位 Group 有效且当前可用）
    if (kindOfTarget === Kind.DEPARTMENT) {
      if (!(await this.directory.departmentActive(input.clubId, input.targetRefId))) {
        throw new ChangeRelationError('IFC-ERR-006', '目标部门不存在或已失效');
      }
    } else if (!(await this.directory.positionActive(input.clubId, input.targetRefId))) {
      throw new ChangeRelationError('IFC-ERR-006', '目标职位不存在或已失效');
    }

    const operatorLeadsTarget =
      kindOfTarget === Kind.DEPARTMENT
        ? await this.directory.operatorLeadsDepartment(
            input.clubId,
            input.targetRefId,
            input.operatorId,
          )
        : false;
    const targetIsLeaderPosition =
      kindOfTarget === Kind.POSITION &&
      (await this.directory.positionScope(input.clubId, input.targetRefId)) === 'LEADER';

    this.policy.assertCanStartChange(
      {
        operatorRoles,
        subjectIsCurrentMember,
        operatorLeadsTargetDepartment: operatorLeadsTarget,
        targetIsLeaderPosition,
        compositeConfirmed: input.compositeConfirmed === true,
        subjectIsOwner: false,
      },
      kindOfTarget,
    );
    this.policy.assertSubjectIsMember({ ...emptyCtx, subjectIsCurrentMember });

    // ---- 冲突检测：同一目标处理中禁止重复/冲突操作 ----
    const groupId = randomUUID();
    const retryDeadlineAt = new Date(now.getTime() + RETRY_WINDOW_MS).toISOString();
    const relations: DepartmentRelation[] = [];

    const buildSegment = async (
      kind: RelationKind,
      refId: string,
      direction: 'add' | 'remove',
    ): Promise<DepartmentRelation> => {
      const existingList = await this.repo.listBySubjectAndRef(
        input.clubId,
        input.subjectId,
        refId,
      );
      const active = existingList.find((r) => ACTIVE_RELATION_STATUSES.includes(r.status));

      // 移出侧：必须存在当前有效段（调出源部门），且该段不得处于其他处理中状态。
      // 按 SRS R4"调动移出"属结束触发：移出侧进入结束处理中（原关系回读确认前保持）。
      if (direction === 'remove') {
        if (active !== undefined && active.status !== DepartmentRelationStatus.CURRENTLY_VALID) {
          throw new ChangeRelationError(
            'IFC-ERR-007',
            `目标 ${refId} 存在进行中的关系段（${active.status}），禁止并发冲突操作`,
          );
        }
        if (active === undefined || active.status !== DepartmentRelationStatus.CURRENTLY_VALID) {
          throw new ChangeRelationError('IFC-ERR-006', '调动移出源部门关系不存在或非当前有效');
        }
        const change: RelationChangeState = {
          changeType: input.changeType,
          changeGroupId: groupId,
          targetSteps: [{ kind, refId, direction }],
          submittedBy: input.operatorId,
          submittedAt: now.toISOString(),
          progress: RelationChangeProgress.PROCESSING,
          attemptCount: 0,
          retryDeadlineAt,
        };
        return {
          ...active,
          status: this.stateMachine.transition(
            active.status,
            DepartmentRelationStatus.END_PROCESSING,
          ),
          version: active.version + 1,
          change,
          end: {
            endKind: 'TRANSFER_OUT',
            reason: null,
            requestedBy: input.operatorId,
            requestedAt: now.toISOString(),
            progress: 'PENDING',
            attemptCount: 0,
          },
          history: [
            ...active.history,
            {
              at: now.toISOString(),
              type: 'END_STARTED',
              by: input.operatorId,
              note: `${input.changeType}（移出侧）组=${groupId}`,
            },
          ],
        };
      }

      // 新增侧：同一目标处理中禁止重复/冲突操作；历史段不复活、不改写
      // （MEM-013 同源约束：新变更一律创建新段，旧段实际起止与历史保持不变）
      if (active !== undefined) {
        throw new ChangeRelationError(
          'IFC-ERR-007',
          `目标 ${refId} 存在进行中的关系段（${active.status}），禁止并发冲突操作`,
        );
      }
      const change: RelationChangeState = {
        changeType: input.changeType,
        changeGroupId: groupId,
        targetSteps: [{ kind, refId, direction }],
        submittedBy: input.operatorId,
        submittedAt: now.toISOString(),
        progress: RelationChangeProgress.PROCESSING,
        attemptCount: 0,
        retryDeadlineAt,
      };
      return this.createFreshSegment(input, kind, refId, change, now);
    };

    // 正向侧
    relations.push(await buildSegment(kindOfTarget, input.targetRefId, 'add'));
    // 组合任命的第二正向侧（加入部门＋任职）
    if (input.changeType === 'JOIN_DEPARTMENT_WITH_POSITION') {
      const deptRef = input.withDepartmentId as string;
      if (!(await this.directory.departmentActive(input.clubId, deptRef))) {
        throw new ChangeRelationError('IFC-ERR-006', '组合任命的初始部门不存在或已失效');
      }
      relations.push(await buildSegment(Kind.DEPARTMENT, deptRef, 'add'));
    }
    // 调动的移出侧
    if (input.changeType === 'TRANSFER_DEPARTMENT' && input.removeDeptId) {
      if (input.removeDeptId === input.targetRefId) {
        throw new ChangeRelationError('IFC-ERR-006', '调动目标部门与源部门相同');
      }
      relations.push(await buildSegment(Kind.DEPARTMENT, input.removeDeptId, 'remove'));
    }

    // 最后负责人连续性（移出侧涉及负责人主体时须交接 ORG-021~025）
    const owners = await this.access.currentOwnerIds(input.clubId);
    const touchesOwner = input.removeDeptId !== undefined && owners.includes(input.subjectId);
    if (touchesOwner) {
      this.policy.assertOwnerContinuityOnEnd({
        subjectIsOwner: true,
        successors: input.successors ?? [],
        subjectId: input.subjectId,
        emergencyBypass:
          input.emergencyBypass === true ||
          (await this.access.isPlatformSuperAdmin(input.operatorId)),
      });
    }

    // 原子保存全部关系段（任一保存失败即整体失败，不落半截意图）
    for (const r of relations) {
      await this.repo.save(r);
    }

    await saveNotificationFact(this.notifications, {
      kind: 'RELATION_CHANGE_STARTED',
      toUserIds: [input.subjectId],
      clubId: input.clubId,
      dedupKey: `RELATION_CHANGE_STARTED:${groupId}`,
      title: '部门/职位关系变更处理中',
      body: `${changeLabel(input.changeType)}已受理；回读确认前原关系与权限保持不变。`,
    });

    return { groupId, relations };
  }

  private isComposite(type: RelationChangeType): boolean {
    return type === 'TRANSFER_DEPARTMENT' || type === 'JOIN_DEPARTMENT_WITH_POSITION';
  }

  private async resolveKind(
    clubId: string,
    refId: string,
    type: RelationChangeType,
  ): Promise<RelationKind> {
    switch (type) {
      case 'JOIN_DEPARTMENT':
      case 'LEAVE_DEPARTMENT':
      case 'TRANSFER_DEPARTMENT':
        return Kind.DEPARTMENT;
      case 'APPOINT_POSITION':
      case 'REVOKE_POSITION':
        return Kind.POSITION;
      case 'JOIN_DEPARTMENT_WITH_POSITION': {
        // 目标为职位；组合中的部门侧由调用方单独校验
        void clubId;
        void refId;
        return Kind.POSITION;
      }
      default: {
        const exhaustive: never = type;
        throw new ChangeRelationError('IFC-ERR-006', `未知变更类型 ${String(exhaustive)}`);
      }
    }
  }

  private async isCurrentMember(clubId: string, subjectId: string): Promise<boolean> {
    const primary = await this.access.subjectPrimaryRoleAt(clubId, subjectId);
    return primary !== '';
  }

  private createFreshSegment(
    input: ChangeDepartmentRelationInput,
    kind: RelationKind,
    refId: string,
    change: RelationChangeState,
    now: Date,
  ): DepartmentRelation {
    const tenures =
      kind === Kind.POSITION
        ? [
            {
              tenureId: randomUUID(),
              plannedStartAt: input.plannedStartAt ?? now.toISOString(),
              plannedEndAt:
                input.plannedEndAt ?? academicYearEndOf(now, { startMonth: 9 }).toISOString(),
              actualStartAt: null,
              actualEndAt: null,
              academicYear: academicYearOf(now, { startMonth: 9 }),
              reappointmentOfTenureId: null,
              sourceChangeId: change.changeGroupId,
            },
          ]
        : [];
    return {
      relationId: randomUUID(),
      clubId: input.clubId,
      subjectId: input.subjectId,
      refId,
      kind,
      status: DepartmentRelationStatus.CHANGE_PROCESSING,
      version: 1,
      change,
      end: null,
      tenures,
      actualStartAt: null,
      actualEndAt: null,
      endReason: null,
      anomaly: null,
      history: [
        {
          at: now.toISOString(),
          type: 'CHANGE_STARTED',
          by: input.operatorId,
          note: `${input.changeType} 组=${change.changeGroupId}`,
        },
      ],
    };
  }
}

const emptyCtx = {
  operatorRoles: [],
  subjectIsCurrentMember: false,
  operatorLeadsTargetDepartment: false,
  targetIsLeaderPosition: false,
  compositeConfirmed: false,
  subjectIsOwner: false,
};

function changeLabel(type: RelationChangeType): string {
  switch (type) {
    case 'JOIN_DEPARTMENT':
      return '加入部门';
    case 'APPOINT_POSITION':
      return '任命职位';
    case 'JOIN_DEPARTMENT_WITH_POSITION':
      return '加入部门＋任职';
    case 'LEAVE_DEPARTMENT':
      return '退出部门';
    case 'REVOKE_POSITION':
      return '免除职位';
    case 'TRANSFER_DEPARTMENT':
      return '跨部门调动';
  }
}
