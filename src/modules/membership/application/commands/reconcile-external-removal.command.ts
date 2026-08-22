import { Inject, Injectable } from '@nestjs/common';

import type {
  MembershipPeriod,
  MembershipRelationTarget,
} from '../../domain/models/membership-period';
import { MembershipPeriodStateMachine } from '../../domain/state-machines/membership-period.state-machine';
import { MEMBERSHIP_REPOSITORY } from '../../infrastructure/membership-repository';
import type { MembershipRepository } from '../../infrastructure/membership-repository';
import { InMemoryMembershipNotificationPort } from '../../infrastructure/in-memory-stubs';
import { MEMBERSHIP_NOTIFICATION_PORT, saveNotificationFact } from '../ports';
import type { MembershipNotificationPort } from '../ports';

/** 外部直接移除对账输入（ORG-026/030、MEM-016；受信任外部管理操作触发） */
export interface ReconcileExternalRemovalInput {
  readonly periodId: string;
  /**
   * Casdoor 当前已无该成员的社团 Group 的**可信确认**结果。
   * false 表示状态无法可信确认——此时不得结束经历，保持当前并进入对账异常。
   */
  readonly trustedConfirmed: boolean;
  /** 可靠上游时间（MEM-016）：能获取时使用，否则用检测时间并标记原始生效时间未知 */
  readonly upstreamAt?: string;
  /** 残留子级关系（部门/职位 Group 仍存在；标记异常且不自动删除，ORG-030） */
  readonly residualTargets?: readonly MembershipRelationTarget[];
  /** 检测来源（对账任务/Webhook 标识；审计留痕） */
  readonly detectedBy?: string;
}

/** 外部移除收口结果 */
export interface ReconcileExternalRemovalResult {
  readonly period: MembershipPeriod;
  /** 经历是否已按外部事实结束（历史成员） */
  readonly ended: boolean;
  /** 状态无法可信确认：保持当前成员并进入对账异常（调用方触发治理告警） */
  readonly reconciliationAnomaly: boolean;
}

/** 对账前置失败（IFC-ERR-006） */
export class ReconcileExternalRemovalError extends Error {
  constructor(message: string) {
    super(`IFC-ERR-006: ${message}`);
    this.name = 'ReconcileExternalRemovalError';
  }
}

/**
 * Casdoor 外部直接移除社团 Group 的对账收口（SRS-SM-MEM-001 转换 8）。
 *
 * - 以 **Casdoor 当前值为准**、不与外部反向覆盖（ORG-026/MEM-016）；
 * - 可信确认社团 Group 已移除 → **立即历史成员**：撤销该社团全部访问；
   追加"Casdoor 外部变更"历史（有可靠上游时间用之，否则检测时间＋未知标记）；
   残留部门/职位关系仅**标记异常、不自动删除**（ORG-030/MEM-016），等待人工修复；
 * - 状态无法可信确认 → 不结束经历：保持当前成员并进入对账异常；
 * - 外部事件幂等：重复事件不重复结束、不追加重复历史。
 */
@Injectable()
export class ReconcileExternalRemovalCommand {
  constructor(
    @Inject(MEMBERSHIP_REPOSITORY) private readonly repo: MembershipRepository,
    @Inject(MEMBERSHIP_NOTIFICATION_PORT)
    private readonly notifications: MembershipNotificationPort = new InMemoryMembershipNotificationPort(),
    private readonly stateMachine: MembershipPeriodStateMachine = new MembershipPeriodStateMachine(),
  ) {}

  async execute(input: ReconcileExternalRemovalInput): Promise<ReconcileExternalRemovalResult> {
    const period = await this.repo.load(input.periodId);
    if (period === null) {
      throw new ReconcileExternalRemovalError('成员经历不存在');
    }

    // 幂等：已因外部变更结束的经历不重复处理
    const alreadyEndedByExternal =
      period.status === 'HISTORICAL_MEMBER' &&
      period.history.some((h) => h.type === 'EXTERNAL_CHANGE');
    if (alreadyEndedByExternal) {
      return { period, ended: true, reconciliationAnomaly: false };
    }

    if (input.trustedConfirmed !== true) {
      // 状态无法可信确认：不得结束经历，保持当前并进入对账异常
      return { period, ended: false, reconciliationAnomaly: true };
    }

    // 转换 8 的源状态仅限当前成员（SRS-SM-MEM-001 §8.1 第 8 行）：
    // 处理中草稿/退出处理中的收口各有专属转换，不得借外部移除越径结束
    if (period.status !== 'CURRENT_MEMBER') {
      throw new ReconcileExternalRemovalError(
        `经历状态为 ${period.status}，仅当前成员可按外部直接移除收口（转换 8）`,
      );
    }

    const now = new Date().toISOString();
    const residuals = input.residualTargets ?? [];
    const ended: MembershipPeriod = {
      ...period,
      version: period.version + 1,
      status: this.stateMachine.transition('CURRENT_MEMBER', 'HISTORICAL_MEMBER'), // 转换 8（存在残留时另标异常）
      actualEndAt: now,
      hasResidualAnomaly: residuals.length > 0,
      history: [
        ...period.history,
        {
          at: now,
          type: 'EXTERNAL_CHANGE',
          by: input.detectedBy ?? 'casdoor-external',
          note:
            input.upstreamAt === undefined
              ? `外部直接移除社团 Group；原始生效时间未知，以检测时间为准${residuals.length > 0 ? `；残留子级关系 ${residuals.length} 条标记异常且不自动删除` : ''}`
              : `外部直接移除社团 Group；上游时间=${input.upstreamAt}${residuals.length > 0 ? `；残留子级关系 ${residuals.length} 条标记异常且不自动删除` : ''}`,
          ...(input.upstreamAt !== undefined ? { upstreamAt: input.upstreamAt } : {}),
          ...(residuals.length > 0 ? { residualTargets: [...residuals] } : {}),
        },
        {
          at: now,
          type: 'PERIOD_ENDED',
          by: 'system',
          note: '外部移除收口：立即撤销本社团全部访问',
        },
      ],
    };
    const swapped = await this.repo.compareAndSwap(period, ended);
    if (!swapped) {
      // 并发竞争（退出执行/其他对账先到）：以最新状态收敛返回
      const latest = await this.repo.load(period.periodId);
      if (latest === null) throw new ReconcileExternalRemovalError('成员经历不存在');
      return {
        period: latest,
        ended: latest.status === 'HISTORICAL_MEMBER',
        reconciliationAnomaly: false,
      };
    }
    // 外部变更通知：成员、负责人、人事与超级管理员（ORG-026；收件人由调用方解析传入）
    await saveNotificationFact(this.notifications, {
      kind: 'MEMBER_EXTERNAL_REMOVAL',
      toUserIds: [ended.subjectId],
      clubId: ended.clubId,
      dedupKey: 'MEMBER_EXTERNAL_REMOVAL:' + ended.periodId,
      title: 'Casdoor 外部变更：社团成员关系已移除',
      body:
        residuals.length > 0
          ? '检测到外部直接移除社团 Group；残留子级关系 ' +
            residuals.length +
            ' 条已标记异常且不自动删除，等待人工处理。'
          : '检测到外部直接移除社团 Group，访问权限已立即撤销；历史保留。',
    });
    return { period: ended, ended: true, reconciliationAnomaly: false };
  }
}
