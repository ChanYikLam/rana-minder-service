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
import { MEMBERSHIP_NOTIFICATION_PORT, saveNotificationFact } from '../ports';
import type { MembershipNotificationPort } from '../ports';
import { InMemoryMembershipNotificationPort } from '../../infrastructure/in-memory-stubs';

/** 结束收口结果 */
export interface SettleRelationEndResult {
  readonly outcome: 'ENDED' | 'KEPT_PROCESSING' | 'RESTORED' | 'ANOMALY';
  readonly relation: DepartmentRelation;
}

/**
 * 关系结束收口（R5/R6；SRS-SM-MEM-002 转换 5/6 行，ORG-027、MEM-003/008~010）。
 *
 * - R5：Casdoor 移除并回读确认目标部门/职位关系 → 历史结束（实际结束时间、
 *   任期实际结束落笔）；只撤销对应权限，不触碰其他关系；
 * - R6：外部失败且回读确认原关系仍完整有效 → 恢复当前有效（不填实际结束时间、
 *   不撤销权限），记录失败并允许人工重试（重新鉴权）；
 * - 无法确认原关系时保持结束处理中或转同步异常；
 * - 幂等：同一关系段只结束一次；重复回调不重复历史。
 */
@Injectable()
export class SettleRelationEndCommand {
  private readonly stateMachine = new DepartmentRelationStateMachine();

  constructor(
    @Inject(DEPARTMENT_RELATION_REPOSITORY)
    private readonly repo: DepartmentRelationRepository,
    @Inject(MEMBERSHIP_CASDOOR_PORT) private readonly casdoor: MembershipCasdoorPort,
    @Inject(MEMBERSHIP_NOTIFICATION_PORT)
    private readonly notifications: MembershipNotificationPort = new InMemoryMembershipNotificationPort(),
  ) {}

  async execute(relationId: string): Promise<SettleRelationEndResult> {
    const relation = await this.repo.load(relationId);
    if (relation === null) {
      throw new Error(`IFC-ERR-015: 关系段 ${relationId} 不存在`);
    }
    if (relation.status !== DepartmentRelationStatus.END_PROCESSING) {
      // 幂等：已收口直接返回当前状态
      return {
        outcome:
          relation.status === DepartmentRelationStatus.HISTORICAL_ENDED
            ? 'ENDED'
            : 'KEPT_PROCESSING',
        relation,
      };
    }

    const nowIso = new Date().toISOString();
    const target: MembershipRelationTargetLike = { kind: relation.kind, refId: relation.refId };
    const results = await this.casdoor.removeAllAndReadBack(
      relation.clubId,
      relation.subjectId,
      [target],
      `relend:${relation.relationId}:${relation.version}`,
    );
    const removed = results[0]?.confirmed === true;

    if (removed) {
      // 防御：回读枚举确认无该目标的残留子关系（快照遗漏不得静默放过，ORG-030）
      const residual = await this.casdoor.listActiveRelationTargets(
        relation.clubId,
        relation.subjectId,
      );
      const stillThere = residual.some(
        (t) => t.kind === relation.kind && t.refId === relation.refId,
      );
      if (stillThere) {
        const kept = this.keepProcessing(relation, nowIso, '回读仍发现目标关系残留');
        await this.repo.save(kept);
        return { outcome: 'KEPT_PROCESSING', relation: kept };
      }

      const ended: DepartmentRelation = {
        ...relation,
        status: this.stateMachine.transition(
          relation.status,
          DepartmentRelationStatus.HISTORICAL_ENDED,
        ),
        version: relation.version + 1,
        actualEndAt: nowIso,
        endReason: relation.end?.endKind ?? null,
        tenures: relation.tenures.map((t, idx) => {
          const isLast = idx === relation.tenures.length - 1;
          if (isLast && t.actualEndAt === null && t.actualStartAt !== null) {
            return { ...t, actualEndAt: nowIso };
          }
          return t;
        }),
        history: [
          ...relation.history,
          {
            at: nowIso,
            type: 'END_CONFIRMED',
            by: 'SYSTEM',
            note: '移除回读确认，只撤销对应权限',
          } satisfies RelationHistoryEvent,
        ],
      };
      await this.repo.save(ended);
      await saveNotificationFact(this.notifications, {
        kind: 'RELATION_END_CONFIRMED',
        toUserIds: [relation.subjectId],
        clubId: relation.clubId,
        dedupKey: `RELATION_END_CONFIRMED:${relation.relationId}:${ended.version}`,
        title: '部门/职位关系已结束',
        body: 'Casdoor 移除并回读确认完成；其他关系不受影响。',
      });
      return { outcome: 'ENDED', relation: ended };
    }

    // 外部失败：先回读确认原关系仍完整有效（R6 前置）
    const intact = await this.casdoor.confirmRelationsIntact(relation.clubId, relation.subjectId, [
      target,
    ]);
    if (intact) {
      const restored: DepartmentRelation = {
        ...relation,
        status: this.stateMachine.transition(
          relation.status,
          DepartmentRelationStatus.CURRENTLY_VALID,
        ),
        version: relation.version + 1,
        end: {
          ...(relation.end as NonNullable<DepartmentRelation['end']>),
          progress: 'FAILED_RESTORED',
          attemptCount: (relation.end?.attemptCount ?? 0) + 1,
          lastError: '外部移除失败，原关系回读确认完整有效，恢复当前有效',
        },
        history: [
          ...relation.history,
          {
            at: nowIso,
            type: 'END_FAILED_RESTORED',
            by: 'SYSTEM',
            note: '执行失败：原关系保持，允许人工重试（重新鉴权）',
          } satisfies RelationHistoryEvent,
        ],
      };
      await this.repo.save(restored);
      await saveNotificationFact(this.notifications, {
        kind: 'RELATION_END_FAILED_RESTORED',
        toUserIds: [relation.subjectId],
        clubId: relation.clubId,
        dedupKey: `RELATION_END_FAILED_RESTORED:${relation.relationId}:${restored.version}`,
        title: '关系结束执行失败（已恢复原关系）',
        body: '外部移除未确认且原关系完整；可人工重试，权限未撤销。',
      });
      return { outcome: 'RESTORED', relation: restored };
    }

    // 无法确认原关系：转同步异常（最小权限收敛）
    const anomaly: DepartmentRelation = {
      ...relation,
      status: this.stateMachine.transition(relation.status, DepartmentRelationStatus.SYNC_ANOMALY),
      version: relation.version + 1,
      anomaly: {
        reason: '结束执行无法确认原关系状态（ORG-027）',
        minimizedTo: ['冻结本段普通授权变更', '等待人工按 Casdoor 当前值修复'],
        markedAt: nowIso,
        anomalyKey: `anomaly:${relation.relationId}:${relation.version}`,
      },
      history: [
        ...relation.history,
        {
          at: nowIso,
          type: 'ANOMALY_MARKED',
          by: 'SYSTEM',
          note: '结束执行无法确认原关系，转同步异常',
        } satisfies RelationHistoryEvent,
      ],
    };
    await this.repo.save(anomaly);
    await saveNotificationFact(this.notifications, {
      kind: 'RELATION_SYNC_ANOMALY',
      toUserIds: [relation.subjectId],
      clubId: relation.clubId,
      dedupKey: `RELATION_SYNC_ANOMALY:${relation.relationId}:${anomaly.version}`,
      title: '关系同步异常（高优先级）',
      body: '结束执行无法确认原关系状态，转人工修复。',
    });
    return { outcome: 'ANOMALY', relation: anomaly };
  }

  private keepProcessing(
    relation: DepartmentRelation,
    nowIso: string,
    note: string,
  ): DepartmentRelation {
    return {
      ...relation,
      version: relation.version + 1,
      end: {
        ...(relation.end as NonNullable<DepartmentRelation['end']>),
        attemptCount: (relation.end?.attemptCount ?? 0) + 1,
        lastError: note,
      },
      history: [
        ...relation.history,
        {
          at: nowIso,
          type: 'END_RETRY_KEPT_PROCESSING',
          by: 'SYSTEM',
          note,
        } satisfies RelationHistoryEvent,
      ],
    };
  }
}

interface MembershipRelationTargetLike {
  readonly kind: 'DEPARTMENT' | 'POSITION';
  readonly refId: string;
}
