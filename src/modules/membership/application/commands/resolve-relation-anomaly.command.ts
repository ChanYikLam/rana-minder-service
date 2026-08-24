import { Inject, Injectable } from '@nestjs/common';

import type {
  DepartmentRelation,
  RelationHistoryEvent,
} from '../../domain/models/department-relation';
import { DepartmentRelationStateMachine } from '../../domain/state-machines/department-relation.state-machine';
import { DepartmentRelationStatus } from '../../domain/state-machines/department-relation.state-machine';
import { DEPARTMENT_RELATION_REPOSITORY } from '../../infrastructure/department-relation-repository';
import type { DepartmentRelationRepository } from '../../infrastructure/department-relation-repository';
import { MEMBERSHIP_CASDOOR_PORT } from '../../infrastructure/casdoor-group.port';
import type { MembershipCasdoorPort } from '../../infrastructure/casdoor-group.port';
import type { MembershipAccessPort } from '../ports';
import {
  MEMBERSHIP_ACCESS_PORT,
  MEMBERSHIP_NOTIFICATION_PORT,
  saveNotificationFact,
} from '../ports';
import type { MembershipNotificationPort } from '../ports';
import { InMemoryMembershipNotificationPort } from '../../infrastructure/in-memory-stubs';

/** 同步异常修复输入（R8；MEM-016、ORG-027/030/034） */
export interface ResolveRelationAnomalyInput {
  readonly clubId: string;
  readonly relationId: string;
  readonly operatorId: string;
  /**
   * 修复方式：通过**正式 Casdoor 关系变更**修复后按回读实际值收口。
   * - CONFIRM_ACTIVE：修复动作已把关系写入 Casdoor 且回读确认存在 → 当前有效；
   * - CONFIRM_REMOVED：修复动作已移除关系且回读确认不存在 → 历史结束/无关系（从未生效则无关系）;
   * 操作者不得跳过回读直接断言。
   */
  readonly resolution: 'CONFIRM_ACTIVE' | 'CONFIRM_REMOVED';
  /** 已查看残留关系和风险的确认标记 */
  readonly riskReviewed: boolean;
}

/** 同步异常修复失败 */
export class ResolveAnomalyError extends Error {
  constructor(
    readonly code: 'IFC-ERR-003' | 'IFC-ERR-006' | 'IFC-ERR-007' | 'IFC-ERR-015',
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = 'ResolveAnomalyError';
  }
}

/**
 * 同步异常人工修复收口（R8：同步异常 → 无关系/当前有效/历史结束）。
 *
 * - **以 Casdoor 当前值收口**：先对目标关系做可信回读，按实际值落定目标态，
 *   不信任操作者断言（未回读确认或仍非法时保持同步异常）；
 * - **不得按历史一键重放全部关系**（ORG-030/034/MEM-016）：本命令只收口单段异常，
 *   不提供批量重放入口；每段必须经正式 Casdoor 关系变更逐一修复；
 * - 原子关闭异常、追加修复历史并通知受影响用户和管理员；
 * - 权限：当前有权管理员或超级管理员按异常权限（服务端重算 ORG-038）。
 */
@Injectable()
export class ResolveRelationAnomalyCommand {
  private readonly stateMachine = new DepartmentRelationStateMachine();

  constructor(
    @Inject(DEPARTMENT_RELATION_REPOSITORY)
    private readonly repo: DepartmentRelationRepository,
    @Inject(MEMBERSHIP_CASDOOR_PORT) private readonly casdoor: MembershipCasdoorPort,
    @Inject(MEMBERSHIP_ACCESS_PORT) private readonly access: MembershipAccessPort,
    @Inject(MEMBERSHIP_NOTIFICATION_PORT)
    private readonly notifications: MembershipNotificationPort = new InMemoryMembershipNotificationPort(),
  ) {}

  async execute(input: ResolveRelationAnomalyInput): Promise<DepartmentRelation> {
    if (!input.riskReviewed) {
      throw new ResolveAnomalyError('IFC-ERR-006', '修复前必须确认已查看残留关系与风险');
    }
    const operatorRoles = await this.access.operatorRolesAt(input.clubId, input.operatorId);
    const isSuper = await this.access.isPlatformSuperAdmin(input.operatorId);
    const privileged =
      isSuper ||
      operatorRoles.includes('CLUB_LEADER') ||
      operatorRoles.includes('HR_ADMIN') ||
      operatorRoles.includes('SUPER_ADMIN');
    if (!privileged) {
      throw new ResolveAnomalyError('IFC-ERR-003', '仅当前有权管理员或超级管理员可处置同步异常');
    }

    const relation = await this.repo.load(input.relationId);
    if (relation === null) {
      throw new ResolveAnomalyError('IFC-ERR-015', '关系段不存在');
    }
    if (relation.clubId !== input.clubId) {
      throw new ResolveAnomalyError('IFC-ERR-006', '关系段与社团不匹配');
    }
    if (relation.status !== DepartmentRelationStatus.SYNC_ANOMALY) {
      // 幂等：非异常段无需修复
      return relation;
    }

    // 以 Casdoor 当前值收口（先回读，不信任断言）
    const actuallyPresent = await this.casdoor.confirmRelationsIntact(
      relation.clubId,
      relation.subjectId,
      [{ kind: relation.kind, refId: relation.refId }],
    );

    let targetStatus: DepartmentRelationStatus;
    if (actuallyPresent) {
      targetStatus = DepartmentRelationStatus.CURRENTLY_VALID;
    } else if (relation.actualStartAt !== null) {
      targetStatus = DepartmentRelationStatus.HISTORICAL_ENDED;
    } else {
      targetStatus = DepartmentRelationStatus.NO_RELATION;
    }

    // 操作者断言与实际值不一致：拒绝并以实际值提示（不得凭断言改写）
    const assertedPresent = input.resolution === 'CONFIRM_ACTIVE';
    if (assertedPresent !== actuallyPresent) {
      throw new ResolveAnomalyError(
        'IFC-ERR-006',
        `修复断言与 Casdoor 当前值不一致（实际${actuallyPresent ? '存在' : '不存在'}）；请先完成正式 Casdoor 关系变更再收口`,
      );
    }

    const nowIso = new Date().toISOString();
    const history: RelationHistoryEvent[] = [
      ...relation.history,
      {
        at: nowIso,
        type: 'ANOMALY_RESOLVED',
        by: input.operatorId,
        note: `按 Casdoor 当前值收口为 ${targetStatus}（单段修复，未重放历史）`,
      },
    ];

    const next: DepartmentRelation = {
      ...relation,
      status: this.stateMachine.transition(relation.status, targetStatus),
      version: relation.version + 1,
      anomaly: null,
      actualStartAt:
        targetStatus === 'CURRENTLY_VALID'
          ? (relation.actualStartAt ?? nowIso)
          : relation.actualStartAt,
      actualEndAt:
        targetStatus === 'HISTORICAL_ENDED'
          ? (relation.actualEndAt ?? nowIso)
          : relation.actualEndAt,
      tenures:
        targetStatus === 'CURRENTLY_VALID'
          ? relation.tenures.map((t, idx) => {
              const isLast = idx === relation.tenures.length - 1;
              return isLast && t.actualStartAt === null ? { ...t, actualStartAt: nowIso } : t;
            })
          : relation.tenures.map((t, idx) => {
              const isLast = idx === relation.tenures.length - 1;
              return isLast &&
                targetStatus === 'HISTORICAL_ENDED' &&
                t.actualEndAt === null &&
                t.actualStartAt !== null
                ? { ...t, actualEndAt: nowIso }
                : t;
            }),
      history,
    };
    await this.repo.save(next);

    await saveNotificationFact(this.notifications, {
      kind: 'RELATION_ANOMALY_RESOLVED',
      toUserIds: [relation.subjectId],
      clubId: relation.clubId,
      dedupKey: `RELATION_ANOMALY_RESOLVED:${relation.relationId}:${next.version}`,
      title: '同步异常已修复',
      body: '已按 Casdoor 当前值完成关系收口。',
    });
    return next;
  }
}
