import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';

import type {
  DepartmentRelation,
  ExternalChangeRecord,
  RelationHistoryEvent,
} from '../../domain/models/department-relation';
import { RelationKind as Kind } from '../../domain/models/department-relation';
import { DepartmentRelationStateMachine } from '../../domain/state-machines/department-relation.state-machine';
import { DepartmentRelationStatus } from '../../domain/state-machines/department-relation.state-machine';
import {
  ACTIVE_RELATION_STATUSES,
  DEPARTMENT_RELATION_REPOSITORY,
} from '../../infrastructure/department-relation-repository';
import type { DepartmentRelationRepository } from '../../infrastructure/department-relation-repository';
import { MEMBERSHIP_CASDOOR_PORT } from '../../infrastructure/casdoor-group.port';
import type { MembershipCasdoorPort } from '../../infrastructure/casdoor-group.port';
import { academicYearEndOf, academicYearOf } from '../../domain/services/relation-change.policy';
import { MEMBERSHIP_NOTIFICATION_PORT, saveNotificationFact } from '../ports';
import type { MembershipNotificationPort } from '../ports';
import { InMemoryMembershipNotificationPort } from '../../infrastructure/in-memory-stubs';

/** 外部直接增删对账输入（R7；ORG-026/030/034、MEM-016） */
export interface ReconcileExternalRelationInput {
  readonly clubId: string;
  readonly subjectId: string;
  readonly kind: 'DEPARTMENT' | 'POSITION';
  readonly refId: string;
  /** Casdoor 观测方向：外部直接加入 / 外部直接移除 */
  readonly observedDirection: 'add' | 'remove';
  /** 可信上游时间（无法获取时省略） */
  readonly upstreamAt?: string;
  /**
   * 外部操作产生的非法状态说明（零负责人/孤立部门职位等）：
   * 提供时对账后落定同步异常并执行最小权限收敛（不得正常授权）。
   */
  readonly illegality?: string;
}

/** 外部变更对账结果 */
export interface ReconcileExternalRelationResult {
  readonly relation: DepartmentRelation;
  readonly settledAs: 'CURRENTLY_VALID' | 'HISTORICAL_ENDED' | 'SYNC_ANOMALY' | 'UNCHANGED';
}

/**
 * Casdoor 外部直接增删关系对账（R7）。
 *
 * - **以 Casdoor 当前结果为准、不自动改回**（ORG-026/MEM-016）：回读确认外部
 *   当前值后落定目标态，并追加"Casdoor 外部变更"历史；
 * - 外部事件幂等：同一上游事件重复对账不重复历史（upstreamAt+方向+目标 去重）；
 * - 外部产生孤立部门/职位、零负责人等非法状态时**不得正常授权**：转同步异常、
 *   执行最小权限收敛并通知超管（ORG-030/034）；
 * - 处理中的关系段不受外部对账影响（先收口处理中命令，避免与业务命令竞争）。
 */
@Injectable()
export class ReconcileExternalRelationCommand {
  private readonly stateMachine = new DepartmentRelationStateMachine();

  constructor(
    @Inject(DEPARTMENT_RELATION_REPOSITORY)
    private readonly repo: DepartmentRelationRepository,
    @Inject(MEMBERSHIP_CASDOOR_PORT) private readonly casdoor: MembershipCasdoorPort,
    @Inject(MEMBERSHIP_NOTIFICATION_PORT)
    private readonly notifications: MembershipNotificationPort = new InMemoryMembershipNotificationPort(),
  ) {}

  async execute(input: ReconcileExternalRelationInput): Promise<ReconcileExternalRelationResult> {
    const now = new Date();
    const nowIso = now.toISOString();

    // 幂等键：上游时间＋方向＋目标（重复事件不重复历史）
    const eventKey = `ext:${input.upstreamAt ?? 'unknown'}:${input.observedDirection}:${input.kind}:${input.refId}`;

    // 现状段：优先进行中段，其次最近历史段
    const segments = await this.repo.listBySubjectAndRef(
      input.clubId,
      input.subjectId,
      input.refId,
    );
    const active = segments.find((r) => ACTIVE_RELATION_STATUSES.includes(r.status));

    if (active !== undefined && active.status !== DepartmentRelationStatus.SYNC_ANOMALY) {
      // 处理中/结束处理中段：业务命令尚未收口，外部对账不改写（保持实际状态，
      // 由命令收口路径按 Casdoor 回读落定），仅当非法状态时立即标异常。
      if (input.illegality !== undefined) {
        const marked = this.markAnomaly(active, input, eventKey, nowIso);
        await this.repo.save(marked);
        await this.notifyAnomaly(marked);
        return { relation: marked, settledAs: 'SYNC_ANOMALY' };
      }
      return { relation: active, settledAs: 'UNCHANGED' };
    }

    // 无活跃段：以最近一段既有段（版本最高）为对账基底，保证外部事件幂等
    // 去重作用于同一段历史；完全无历史时才新建承载段。
    const base = active ?? segments[0] ?? (await this.createBaseSegment(input, now));

    // 以 Casdoor 当前值复核观测方向（可信当前值 ORG-026）
    const actuallyPresent = await this.casdoor.confirmRelationsIntact(
      input.clubId,
      input.subjectId,
      [{ kind: input.kind, refId: input.refId }],
    );

    let settledAs: ExternalChangeRecord['settledAs'];
    if (
      input.illegality !== undefined ||
      (input.observedDirection === 'remove' && actuallyPresent)
    ) {
      // 非法状态或移除后仍存在残留 → 同步异常 + 最小权限收敛
      settledAs = 'SYNC_ANOMALY';
    } else if (input.observedDirection === 'add' && actuallyPresent) {
      settledAs = 'CURRENTLY_VALID';
    } else if (input.observedDirection === 'add' && !actuallyPresent) {
      // 外部加入未获回读确认：不得正常授权，转异常待人工修复
      settledAs = 'SYNC_ANOMALY';
    } else {
      settledAs = 'HISTORICAL_ENDED';
    }

    const next = this.applyExternalSettlement(base, input, eventKey, settledAs, nowIso);
    await this.repo.save(next);

    if (settledAs === 'SYNC_ANOMALY') {
      await this.notifyAnomaly(next);
    } else {
      await saveNotificationFact(this.notifications, {
        kind: 'RELATION_EXTERNAL_CHANGE',
        toUserIds: [input.subjectId],
        clubId: input.clubId,
        dedupKey: `RELATION_EXTERNAL_CHANGE:${eventKey}`,
        title: 'Casdoor 外部关系变更已对账',
        body:
          settledAs === 'CURRENTLY_VALID'
            ? '检测到 Casdoor 直接加入关系，已按当前值确认生效。'
            : '检测到 Casdoor 直接移除关系，已按当前值结束该关系。',
      });
    }
    return { relation: next, settledAs };
  }

  /** 无任何既有段时为外部加入建立承载段（外部任命同时建立独立任期 MEM-010） */
  private async createBaseSegment(
    input: ReconcileExternalRelationInput,
    now: Date,
  ): Promise<DepartmentRelation> {
    return {
      relationId: randomUUID(),
      clubId: input.clubId,
      subjectId: input.subjectId,
      refId: input.refId,
      kind: input.kind === 'DEPARTMENT' ? Kind.DEPARTMENT : Kind.POSITION,
      status: DepartmentRelationStatus.NO_RELATION,
      version: 1,
      change: null,
      end: null,
      tenures:
        input.kind === 'POSITION'
          ? [
              {
                tenureId: randomUUID(),
                plannedStartAt: now.toISOString(),
                plannedEndAt: academicYearEndOf(now, { startMonth: 9 }).toISOString(),
                actualStartAt: null,
                actualEndAt: null,
                academicYear: academicYearOf(now, { startMonth: 9 }),
                reappointmentOfTenureId: null,
                sourceChangeId: 'EXTERNAL_RECONCILE',
              },
            ]
          : [],
      actualStartAt: null,
      actualEndAt: null,
      endReason: null,
      anomaly: null,
      history: [],
    };
  }

  private applyExternalSettlement(
    base: DepartmentRelation,
    input: ReconcileExternalRelationInput,
    eventKey: string,
    settledAs: ExternalChangeRecord['settledAs'],
    nowIso: string,
  ): DepartmentRelation {
    // 幂等：同事件已记录则原样返回（重复回调不重复历史）
    if (
      base.history.some(
        (e) => e.external?.externalEventKey === eventKey && e.external.settledAs === settledAs,
      )
    ) {
      return base;
    }

    const external: ExternalChangeRecord = {
      at: nowIso,
      ...(input.upstreamAt !== undefined ? { upstreamAt: input.upstreamAt } : {}),
      direction: input.observedDirection,
      settledAs,
      ...(input.illegality !== undefined ? { illegality: input.illegality } : {}),
      externalEventKey: eventKey,
    };

    let status: DepartmentRelationStatus = base.status;
    let tenures = base.tenures;
    const anomalyBase = base.status === DepartmentRelationStatus.SYNC_ANOMALY;
    if (anomalyBase) {
      // 同步异常段只能经 R8 人工修复收口；外部事件仅追加历史，不自动改回/解除异常
      status = base.status;
    } else if (settledAs === 'CURRENTLY_VALID') {
      status = this.stateMachine.transition(base.status, DepartmentRelationStatus.CURRENTLY_VALID);
      // 外部任命确认生效：最后一个任期补实际开始
      tenures = base.tenures.map((t, idx) => {
        const isLast = idx === base.tenures.length - 1;
        return isLast && t.actualStartAt === null ? { ...t, actualStartAt: nowIso } : t;
      });
    } else if (settledAs === 'HISTORICAL_ENDED') {
      status = this.stateMachine.transition(base.status, DepartmentRelationStatus.HISTORICAL_ENDED);
      tenures = base.tenures.map((t, idx) => {
        const isLast = idx === base.tenures.length - 1;
        return isLast && t.actualEndAt === null && t.actualStartAt !== null
          ? { ...t, actualEndAt: nowIso }
          : t;
      });
    } else {
      status = this.stateMachine.transition(base.status, DepartmentRelationStatus.SYNC_ANOMALY);
    }

    const history: RelationHistoryEvent[] = [
      ...base.history,
      {
        at: nowIso,
        type: 'EXTERNAL_CHANGE',
        by: 'CASDOOR_EXTERNAL',
        note:
          settledAs === 'SYNC_ANOMALY'
            ? `外部${input.observedDirection === 'add' ? '加入' : '移除'}产生非法状态或未获确认`
            : `外部直接${input.observedDirection === 'add' ? '加入' : '移除'}，按当前值落定`,
        external,
      },
    ];

    if (settledAs === 'SYNC_ANOMALY') {
      history.push({
        at: nowIso,
        type: 'ANOMALY_MARKED',
        by: 'SYSTEM',
        note: input.illegality ?? '外部变更未能按当前值确认',
      });
    }

    return {
      ...base,
      status,
      version: base.version + 1,
      tenures,
      actualStartAt:
        settledAs === 'CURRENTLY_VALID' && !anomalyBase
          ? (base.actualStartAt ?? nowIso)
          : base.actualStartAt,
      actualEndAt:
        settledAs === 'HISTORICAL_ENDED' && !anomalyBase
          ? (base.actualEndAt ?? nowIso)
          : base.actualEndAt,
      anomaly: anomalyBase
        ? base.anomaly
        : settledAs === 'SYNC_ANOMALY'
          ? {
              reason: input.illegality ?? '外部变更未能按 Casdoor 当前值确认',
              minimizedTo: ['冻结本段普通授权', '等待人工按 Casdoor 当前值修复'],
              markedAt: nowIso,
              anomalyKey: `anomaly:${base.relationId}:${base.version}`,
            }
          : null,
      history,
    };
  }

  private markAnomaly(
    segment: DepartmentRelation,
    input: ReconcileExternalRelationInput,
    _eventKey: string,
    nowIso: string,
  ): DepartmentRelation {
    void _eventKey;
    void input;
    return {
      ...segment,
      status: this.stateMachine.transition(segment.status, DepartmentRelationStatus.SYNC_ANOMALY),
      version: segment.version + 1,
      anomaly: {
        reason: '外部变更产生零负责人/孤立关系等非法状态（ORG-030/034）',
        minimizedTo: ['冻结本段普通授权', '最小权限收敛等待人工修复'],
        markedAt: nowIso,
        anomalyKey: `anomaly:${segment.relationId}:${segment.version}`,
      },
      history: [
        ...segment.history,
        {
          at: nowIso,
          type: 'ANOMALY_MARKED',
          by: 'SYSTEM',
          note: input.illegality ?? '外部非法状态',
        },
      ],
    };
  }

  private async notifyAnomaly(relation: DepartmentRelation): Promise<void> {
    await saveNotificationFact(this.notifications, {
      kind: 'RELATION_SYNC_ANOMALY',
      toUserIds: [relation.subjectId],
      clubId: relation.clubId,
      dedupKey: `RELATION_SYNC_ANOMALY_EXT:${relation.relationId}:${relation.version}`,
      title: 'Casdoor 外部变更产生同步异常（高优先级）',
      body: '外部直接变更产生非法状态，已收敛最小权限并通知超级管理员处置。',
    });
  }
}
