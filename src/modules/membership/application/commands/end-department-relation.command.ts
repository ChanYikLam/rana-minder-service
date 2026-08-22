import { Inject, Injectable } from '@nestjs/common';

import type { DepartmentRelation, RelationEndState } from '../../domain/models/department-relation';
import { RelationChangePolicy } from '../../domain/services/relation-change.policy';
import { DepartmentRelationStateMachine } from '../../domain/state-machines/department-relation.state-machine';
import { DepartmentRelationStatus } from '../../domain/state-machines/department-relation.state-machine';
import { DEPARTMENT_RELATION_REPOSITORY } from '../../infrastructure/department-relation-repository';
import type { DepartmentRelationRepository } from '../../infrastructure/department-relation-repository';
import {
  MEMBERSHIP_ACCESS_PORT,
  MEMBERSHIP_NOTIFICATION_PORT,
  saveNotificationFact,
} from '../ports';
import type { MembershipAccessPort, MembershipNotificationPort } from '../ports';
import { InMemoryMembershipNotificationPort } from '../../infrastructure/in-memory-stubs';

/** 发起关系结束输入（R4：当前有效 → 结束处理中；MEM-003/005/006/008~010） */
export interface EndDepartmentRelationInput {
  readonly clubId: string;
  readonly subjectId: string;
  readonly operatorId: string;
  readonly relationId: string;
  readonly endKind: 'LEAVE_DEPARTMENT' | 'RESIGN_POSITION' | 'DISMISS_POSITION';
  readonly reason?: string;
  /** 审批事实满足（退部批准/辞职上级批准/免职有权决定；由用例链路传入） */
  readonly approvalSatisfied: boolean;
  /** 最后负责人交接锚点（撤销负责人时同命令指定继任者 ORG-024） */
  readonly successors?: readonly string[];
  /** 超级管理员紧急处置豁免 */
  readonly emergencyBypass?: boolean;
}

/** 发起结束失败（IFC-ERR-003/006/007/015） */
export class EndRelationError extends Error {
  constructor(
    readonly code: 'IFC-ERR-003' | 'IFC-ERR-006' | 'IFC-ERR-007' | 'IFC-ERR-015',
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = 'EndRelationError';
  }
}

/**
 * 发起部门/职位关系结束（R4：当前有效 → 结束处理中）。
 *
 * - 原子保存结束决定、关系快照与 Casdoor 移除任务意图；实际结束时间尚不填写；
 * - 只针对单一目标关系段：不得误删其他部门、职位或成员关系（MEM-009）；
 * - 审批/决定前置满足（退部批准、辞职上级批准、免职有权管理员）；
 * - 最后负责人连续性满足（ORG-021~025）：撤销唯一负责人须同命令交接或超管紧急处置；
 * - 与续任/其他变更竞争只一个成功（版本比较交换）。
 */
@Injectable()
export class EndDepartmentRelationCommand {
  private readonly stateMachine = new DepartmentRelationStateMachine();
  private readonly policy = new RelationChangePolicy();

  constructor(
    @Inject(DEPARTMENT_RELATION_REPOSITORY)
    private readonly repo: DepartmentRelationRepository,
    @Inject(MEMBERSHIP_ACCESS_PORT) private readonly access: MembershipAccessPort,
    @Inject(MEMBERSHIP_NOTIFICATION_PORT)
    private readonly notifications: MembershipNotificationPort = new InMemoryMembershipNotificationPort(),
  ) {}

  async execute(input: EndDepartmentRelationInput): Promise<DepartmentRelation> {
    const relation = await this.repo.load(input.relationId);
    if (relation === null) {
      throw new EndRelationError('IFC-ERR-015', '关系段不存在');
    }
    if (relation.clubId !== input.clubId || relation.subjectId !== input.subjectId) {
      throw new EndRelationError('IFC-ERR-006', '关系段与目标社团/成员不匹配');
    }

    // 操作者权限（服务端重算 ORG-038）：免职需负责人/人事层级；退部/辞职由审批链路保证
    const operatorRoles = await this.access.operatorRolesAt(input.clubId, input.operatorId);
    const isSuper = await this.access.isPlatformSuperAdmin(input.operatorId);
    if (operatorRoles.length === 0 && !isSuper) {
      throw new EndRelationError('IFC-ERR-003', '操作者在该社团无有效管理角色');
    }
    if (input.endKind === 'DISMISS_POSITION' && input.operatorId === input.subjectId) {
      throw new EndRelationError('IFC-ERR-003', '不能通过免职入口处理自己');
    }

    this.policy.assertEndApproval({
      operatorRoles,
      approvalSatisfied: input.approvalSatisfied,
      subjectIsOwner: false,
    });

    // 最后负责人连续性（ORG-021~025）：撤销负责人主体须交接或超管紧急处置
    const owners = await this.access.currentOwnerIds(input.clubId);
    const subjectIsOwner = owners.includes(input.subjectId);
    // 层级门控（ORG-021）：人事管理员不得直接免职负责人（仅正式换届流程）；
    // 部门负责人更无权触碰负责人职位。
    if (
      subjectIsOwner &&
      !operatorRoles.includes('CLUB_LEADER') &&
      !isSuper &&
      input.emergencyBypass !== true
    ) {
      throw new EndRelationError(
        'IFC-ERR-003',
        '免除负责人职位仅社团负责人或超级管理员可操作（ORG-021）',
      );
    }
    this.policy.assertOwnerContinuityOnEnd({
      subjectIsOwner,
      successors: input.successors ?? [],
      emergencyBypass: input.emergencyBypass === true || isSuper,
    });

    // 单一目标范围（不得误删其他关系）
    this.policy.assertSingleTargetScope([{ kind: relation.kind, refId: relation.refId }]);

    const nowIso = new Date().toISOString();
    const end: RelationEndState = {
      endKind: input.endKind,
      reason: input.reason ?? null,
      requestedBy: input.operatorId,
      requestedAt: nowIso,
      progress: 'PENDING',
      attemptCount: 0,
    };
    const next: DepartmentRelation = {
      ...relation,
      status: this.stateMachine.transition(
        relation.status,
        DepartmentRelationStatus.END_PROCESSING,
      ),
      version: relation.version + 1,
      end,
      history: [
        ...relation.history,
        {
          at: nowIso,
          type: 'END_STARTED',
          by: input.operatorId,
          note: `${endKindLabel(input.endKind)}${input.reason ? `：${input.reason}` : ''}`,
        },
      ],
    };
    await this.repo.save(next);

    await saveNotificationFact(this.notifications, {
      kind: 'RELATION_END_STARTED',
      toUserIds: [input.subjectId],
      clubId: input.clubId,
      dedupKey: `RELATION_END_STARTED:${input.relationId}:${next.version}`,
      title: '部门/职位关系结束处理中',
      body: `${endKindLabel(input.endKind)}已受理；移除回读确认前原权限保持不变。`,
    });
    return next;
  }
}

function endKindLabel(kind: RelationEndState['endKind']): string {
  switch (kind) {
    case 'LEAVE_DEPARTMENT':
      return '退出部门';
    case 'RESIGN_POSITION':
      return '职位辞职生效';
    case 'DISMISS_POSITION':
    case 'TRANSFER_OUT':
      return kind === 'DISMISS_POSITION' ? '免除职位' : '调动移出';
  }
}
