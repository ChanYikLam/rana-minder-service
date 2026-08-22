import { Inject, Injectable } from '@nestjs/common';

import type {
  DepartmentRelation,
  RelationHistoryEvent,
} from '../../domain/models/department-relation';
import { RelationChangeProgress } from '../../domain/models/department-relation';
import { DepartmentRelationStateMachine } from '../../domain/state-machines/department-relation.state-machine';
import { DepartmentRelationStatus } from '../../domain/state-machines/department-relation.state-machine';
import { DEPARTMENT_RELATION_REPOSITORY } from '../../infrastructure/department-relation-repository';
import type { DepartmentRelationRepository } from '../../infrastructure/department-relation-repository';
import { MEMBERSHIP_CASDOOR_PORT } from '../../infrastructure/casdoor-group.port';
import type { MembershipCasdoorPort } from '../../infrastructure/casdoor-group.port';
import type { MembershipRelationTarget } from '../../domain/models/membership-period';
import { MEMBERSHIP_NOTIFICATION_PORT, saveNotificationFact } from '../ports';
import type { MembershipNotificationPort } from '../ports';
import { InMemoryMembershipNotificationPort } from '../../infrastructure/in-memory-stubs';

/** 自动重试窗口（ORG-027） */
const RETRY_WINDOW_MS = 15 * 60 * 1000;

/** 变更收口结果 */
export interface SettleRelationChangeResult {
  readonly groupId: string;
  readonly outcome: 'CONFIRMED' | 'KEPT_PROCESSING' | 'COMPENSATED' | 'ANOMALY';
  readonly relations: readonly DepartmentRelation[];
}

/**
 * 关系变更收口（R2/R3；SRS-SM-MEM-002 转换 2/3 行，ORG-027/034、MEM-009/011）。
 *
 * - **先回读后判定**：对变更组内全部目标步骤执行 Casdoor 写入＋定向回读；
 *   全部复合步骤确认才生效（部分确认不得标当前有效）；
 * - R2 全部确认：新增侧 → 当前有效（实际开始/任期实际开始落笔），移出侧 → 历史结束
 *   （实际结束落笔）；跨部门调动整体生效、不得半完成（MEM-009）；
 * - R3 失败：窗口内保持处理中（失败标志）；需要收口时按逆序补偿已写入目标，
 *   补偿回读确认 → 回原状态（无关系/历史结束/当前有效）；补偿未确认 → 同步异常
 *   （最小权限收敛）并通知超管；
 * - 幂等：同组重复收口按当前状态幂等处理；每次尝试先回读再执行。
 *
 * 系统任务身份调用（生产由 job 模块承载；开发期由测试/超管入口驱动）。
 */
@Injectable()
export class SettleRelationChangeCommand {
  private readonly stateMachine = new DepartmentRelationStateMachine();

  constructor(
    @Inject(DEPARTMENT_RELATION_REPOSITORY)
    private readonly repo: DepartmentRelationRepository,
    @Inject(MEMBERSHIP_CASDOOR_PORT) private readonly casdoor: MembershipCasdoorPort,
    @Inject(MEMBERSHIP_NOTIFICATION_PORT)
    private readonly notifications: MembershipNotificationPort = new InMemoryMembershipNotificationPort(),
  ) {}

  /** 按业务命令组 id 收口（全部涉及段原子推进；单段失败整体保持原状） */
  async execute(groupId: string): Promise<SettleRelationChangeResult> {
    const relations = await this.loadByGroup(groupId);
    if (relations.length === 0) {
      throw new Error(`IFC-ERR-015: 未找到变更组 ${groupId} 的任何关系段`);
    }
    const first = relations[0];
    const now = new Date();
    const nowIso = now.toISOString();

    // 幂等：组内任一段仍处处理中才推进；否则按已落定段状态推导结果
    // （新增侧＝变更处理中；移出侧＝结束处理中——SRS R4 调动移出属结束触发）
    const processing = relations.filter(
      (r) =>
        r.status === DepartmentRelationStatus.CHANGE_PROCESSING ||
        r.status === DepartmentRelationStatus.END_PROCESSING,
    );
    if (processing.length === 0) {
      // 重复收口：不得把"已收口"误判为成功——按段状态还原上次结论
      const anyAnomaly = relations.some((r) => r.status === DepartmentRelationStatus.SYNC_ANOMALY);
      const allSuccess = relations.every(
        (r) =>
          r.status === DepartmentRelationStatus.CURRENTLY_VALID ||
          r.status === DepartmentRelationStatus.HISTORICAL_ENDED,
      );
      const compensatedShape = relations.some(
        (r) =>
          r.status === DepartmentRelationStatus.NO_RELATION &&
          r.history.some((e) => e.type === 'CHANGE_COMPENSATED'),
      );
      const derivedOutcome: SettleRelationChangeResult['outcome'] = anyAnomaly
        ? 'ANOMALY'
        : allSuccess
          ? 'CONFIRMED'
          : compensatedShape
            ? 'COMPENSATED'
            : 'KEPT_PROCESSING';
      return { groupId, outcome: derivedOutcome, relations };
    }

    const clubId = first.clubId;
    const subjectId = first.subjectId;
    const addTargets: MembershipRelationTarget[] = [];
    const removeTargets: MembershipRelationTarget[] = [];
    for (const r of processing) {
      for (const step of r.change?.targetSteps ?? []) {
        const target: MembershipRelationTarget = { kind: step.kind, refId: step.refId };
        if (step.direction === 'add') addTargets.push(target);
        else removeTargets.push(target);
      }
    }

    const idempotencyKey = `relchg:${groupId}`;
    let confirmedAll = true;
    let anyHardFailure = false;

    // 先移除侧后新增侧（先撤销后授予，CAS-WR-013 顺序语义）
    if (removeTargets.length > 0) {
      const results = await this.casdoor.removeAllAndReadBack(
        clubId,
        subjectId,
        removeTargets,
        idempotencyKey,
      );
      for (const res of results) {
        if (!res.confirmed) {
          confirmedAll = false;
          if (!res.ok) anyHardFailure = true;
        }
      }
    }
    if (confirmedAll && addTargets.length > 0) {
      const results = await this.casdoor.addAndReadBack(
        clubId,
        subjectId,
        addTargets,
        idempotencyKey,
      );
      for (const res of results) {
        if (!res.confirmed) {
          confirmedAll = false;
          if (!res.ok) anyHardFailure = true;
        }
      }
    }

    // R2：全部回读确认 → 生效
    if (confirmedAll) {
      const settled: DepartmentRelation[] = [];
      for (const r of relations) {
        const isAddSide = r.status === DepartmentRelationStatus.CHANGE_PROCESSING;
        const isRemoveSide = r.status === DepartmentRelationStatus.END_PROCESSING;
        if (!isAddSide && !isRemoveSide) {
          settled.push(r);
          continue;
        }
        const next = isAddSide ? this.confirmAdd(r, nowIso) : this.confirmRemove(r, nowIso);
        await this.repo.save(next);
        settled.push(next);
      }
      await saveNotificationFact(this.notifications, {
        kind: 'RELATION_CHANGE_CONFIRMED',
        toUserIds: [subjectId],
        clubId,
        dedupKey: `RELATION_CHANGE_CONFIRMED:${groupId}`,
        title: '部门/职位关系已生效',
        body: 'Casdoor 写入并回读确认完成，关系与对应权限已生效。',
      });
      return { groupId, outcome: 'CONFIRMED', relations: settled };
    }

    // 判定是否进入收口分支：硬失败或超出自动重试窗口 → 补偿路径
    const retryDeadline = processing[0]?.change?.retryDeadlineAt ?? null;
    const withinWindow =
      retryDeadline !== null && Date.parse(retryDeadline) > now.getTime() && !anyHardFailure;

    if (withinWindow) {
      // 自环：保持处理中并带失败/重试标志（先回读后重试）
      const kept: DepartmentRelation[] = [];
      for (const r of relations) {
        const isAddSide = r.status === DepartmentRelationStatus.CHANGE_PROCESSING;
        const isRemoveSide = r.status === DepartmentRelationStatus.END_PROCESSING;
        if (!isAddSide && !isRemoveSide) {
          kept.push(r);
          continue;
        }
        if (isAddSide) {
          const attemptCount = (r.change?.attemptCount ?? 0) + 1;
          const next: DepartmentRelation = {
            ...r,
            version: r.version + 1,
            change: {
              ...(r.change as NonNullable<DepartmentRelation['change']>),
              progress: RelationChangeProgress.FAILED_PENDING_RETRY,
              attemptCount,
              lastError: '外部写入未全部确认，保持处理中等待重试（先回读后重试）',
            },
            history: [
              ...r.history,
              {
                at: nowIso,
                type: 'CHANGE_RETRY_KEPT_PROCESSING',
                by: 'SYSTEM',
                note: `第 ${attemptCount} 次尝试未全部确认`,
              } satisfies RelationHistoryEvent,
            ],
          };
          await this.repo.save(next);
          kept.push(next);
        } else {
          const attemptCount = (r.end?.attemptCount ?? 0) + 1;
          const next: DepartmentRelation = {
            ...r,
            version: r.version + 1,
            end: {
              ...(r.end as NonNullable<DepartmentRelation['end']>),
              attemptCount,
              lastError: '外部移除未全部确认，保持结束处理中等待重试（先回读后重试）',
            },
            history: [
              ...r.history,
              {
                at: nowIso,
                type: 'END_RETRY_KEPT_PROCESSING',
                by: 'SYSTEM',
                note: `第 ${attemptCount} 次尝试未全部确认`,
              } satisfies RelationHistoryEvent,
            ],
          };
          await this.repo.save(next);
          kept.push(next);
        }
      }
      return { groupId, outcome: 'KEPT_PROCESSING', relations: kept };
    }

    // R3：补偿路径——逆序补偿已写入目标（新增侧移除），回读确认才算补偿完成；
    // 移除侧未确认时恢复原关系（重新加入并回读）
    let compensated = true;
    if (addTargets.length > 0) {
      compensated = await this.compensateAdds(clubId, subjectId, addTargets, groupId);
    }
    if (compensated && removeTargets.length > 0) {
      compensated = await this.restoreRemoves(clubId, subjectId, removeTargets, groupId);
    }

    const settled: DepartmentRelation[] = [];
    for (const r of relations) {
      const isAddSide = r.status === DepartmentRelationStatus.CHANGE_PROCESSING;
      const isRemoveSide = r.status === DepartmentRelationStatus.END_PROCESSING;
      if (!isAddSide && !isRemoveSide) {
        settled.push(r);
        continue;
      }
      const next = compensated
        ? this.settleCompensated(r, nowIso)
        : this.settleAnomaly(r, nowIso, compensated);
      await this.repo.save(next);
      settled.push(next);
    }

    if (!compensated) {
      await saveNotificationFact(this.notifications, {
        kind: 'RELATION_SYNC_ANOMALY',
        toUserIds: [subjectId],
        clubId,
        dedupKey: `RELATION_SYNC_ANOMALY:${groupId}`,
        title: '关系同步异常（高优先级）',
        body: '关系写入无法确认且补偿未收口，已收敛最小权限并转人工修复。',
      });
    }

    return {
      groupId,
      outcome: compensated ? 'COMPENSATED' : 'ANOMALY',
      relations: settled,
    };
  }

  /** R2 新增侧确认 → 当前有效（实际开始/任期实际开始落笔；旧历史不覆盖） */
  private confirmAdd(r: DepartmentRelation, nowIso: string): DepartmentRelation {
    const tenures = r.tenures.map((t, idx) => {
      const isLast = idx === r.tenures.length - 1;
      if (isLast && t.actualStartAt === null) {
        return { ...t, actualStartAt: nowIso };
      }
      return t;
    });
    return {
      ...r,
      status: this.stateMachine.transition(r.status, DepartmentRelationStatus.CURRENTLY_VALID),
      version: r.version + 1,
      actualStartAt: nowIso,
      tenures,
      history: [
        ...r.history,
        {
          at: nowIso,
          type: 'CHANGE_CONFIRMED',
          by: 'SYSTEM',
          note: `组=${r.change?.changeGroupId} 回读确认生效`,
        } satisfies RelationHistoryEvent,
      ],
    };
  }

  /** R2 移出侧（调动）确认 → 历史结束（实际结束落笔；END_PROCESSING 出边） */
  private confirmRemove(r: DepartmentRelation, nowIso: string): DepartmentRelation {
    const tenures = r.tenures.map((t, idx) => {
      const isLast = idx === r.tenures.length - 1;
      if (isLast && t.actualEndAt === null && t.actualStartAt !== null) {
        return { ...t, actualEndAt: nowIso };
      }
      return t;
    });
    return {
      ...r,
      status: this.stateMachine.transition(r.status, DepartmentRelationStatus.HISTORICAL_ENDED),
      version: r.version + 1,
      actualEndAt: nowIso,
      endReason: 'TRANSFER_OUT',
      tenures,
      history: [
        ...r.history,
        {
          at: nowIso,
          type: 'END_CONFIRMED',
          by: 'SYSTEM',
          note: `组=${r.change?.changeGroupId} 调动移出生效`,
        } satisfies RelationHistoryEvent,
      ],
    };
  }

  /** R3 补偿成功：新增侧回无关系（新段从未生效），移出侧恢复当前有效 */
  private settleCompensated(r: DepartmentRelation, nowIso: string): DepartmentRelation {
    const isAddSide = r.status === DepartmentRelationStatus.CHANGE_PROCESSING;
    const previousStatus = isAddSide
      ? DepartmentRelationStatus.NO_RELATION
      : DepartmentRelationStatus.CURRENTLY_VALID;
    return {
      ...r,
      status: this.stateMachine.transition(r.status, previousStatus),
      version: r.version + 1,
      actualStartAt: isAddSide ? null : r.actualStartAt,
      actualEndAt: null,
      endReason: null,
      history: [
        ...r.history,
        {
          at: nowIso,
          type: 'CHANGE_COMPENSATED',
          by: 'SYSTEM',
          note: `组=${r.change?.changeGroupId} 补偿完成，回到${isAddSide ? '无关系' : '当前有效'}`,
        } satisfies RelationHistoryEvent,
      ],
    };
  }

  /** R3 补偿未确认：同步异常（最小权限收敛标记；不删除历史） */
  private settleAnomaly(
    r: DepartmentRelation,
    nowIso: string,
    _compensated: boolean,
  ): DepartmentRelation {
    void _compensated;
    return {
      ...r,
      status: this.stateMachine.transition(r.status, DepartmentRelationStatus.SYNC_ANOMALY),
      version: r.version + 1,
      anomaly: {
        reason: '关系变更写入未全部确认且补偿未收口（ORG-027/034）',
        minimizedTo: ['冻结本段普通授权变更', '保留既有最小关系等待人工修复'],
        markedAt: nowIso,
        anomalyKey: `anomaly:${r.relationId}:${r.version}`,
      },
      history: [
        ...r.history,
        {
          at: nowIso,
          type: 'ANOMALY_MARKED',
          by: 'SYSTEM',
          note: `组=${r.change?.changeGroupId} 补偿未确认，转同步异常`,
        } satisfies RelationHistoryEvent,
      ],
    };
  }

  /** 补偿新增侧：逐项移除并回读（每步幂等） */
  private async compensateAdds(
    clubId: string,
    subjectId: string,
    addTargets: readonly MembershipRelationTarget[],
    groupId: string,
  ): Promise<boolean> {
    if (addTargets.length === 0) return true;
    const results = await this.casdoor.removeAllAndReadBack(
      clubId,
      subjectId,
      [...addTargets].reverse(),
      `compensate:${groupId}`,
    );
    return results.every((res) => res.confirmed);
  }

  /** 恢复移除侧：重新加入并回读（保持原关系 ORG-027） */
  private async restoreRemoves(
    clubId: string,
    subjectId: string,
    removeTargets: readonly MembershipRelationTarget[],
    groupId: string,
  ): Promise<boolean> {
    const results = await this.casdoor.addAndReadBack(
      clubId,
      subjectId,
      [...removeTargets],
      `restore:${groupId}`,
    );
    return results.every((res) => res.confirmed);
  }

  private async loadByGroup(groupId: string): Promise<DepartmentRelation[]> {
    return this.repo.findByChangeGroup(groupId);
  }
}

// re-export window constant for tests
export { RETRY_WINDOW_MS };
