/**
 * IDN-003 资料同步收口策略（SRS-SM-IDN-003；IDN-006/007/017/020、DATA-CAS-003）。
 *
 * 纯规则，输入为读回值/时间/版本事实，输出收口决策；不执行外部调用。
 *
 * 决策表：
 * - 读回 = 本地目标值        → SYNCED（目标收口）
 * - 读回 = 修改前有效值      → ROLLED_BACK（先可信读回才回退，防止把已成功写入
 *   制造成不一致；存在更晚已确认修改或读回不可信时不得回退）
 * - 读回为第三值：
 *   · 只读权威字段（姓名/学号）→ CONVERGE_AUTHORITATIVE（直接收敛 Casdoor 当前值，
 *     不进入本人选择，PRD-OPT-045/IDN-017）
 *   · 普通可编辑字段           → CONFLICT（保存冲突快照，本人选择；管理员不得代选）
 * - 连续失败 24 小时          → 停止盲目重试并强制读回（冻结盲写重试）
 *
 * 重试边界（正常目标 5 分钟，IDN-020）：退避按尝试次数指数增长并封顶，仍可度量。
 */

import type { EditableProfileField } from '../models/profile-field';

export type ReadbackDecision =
  | 'SYNCED'
  | 'ROLLED_BACK'
  | 'CONFLICT'
  | 'CONVERGE_AUTHORITATIVE'
  | 'READBACK_UNTRUSTWORTHY';

export interface ReadbackFacts<TValue = string | null> {
  readonly field: EditableProfileField | 'studentId' | 'name';
  /** 本地目标值（本次同步意图的目标） */
  readonly targetValue: TValue;
  /** 修改前有效值 */
  readonly priorValue: TValue | null;
  /** 最近可信读回值 */
  readonly readbackValue: TValue;
  /** 是否存在更晚已确认修改（有则旧回退/旧冲突拒绝） */
  readonly hasNewerConfirmedChange: boolean;
}

export interface ProfileSyncPolicy {
  /** 读回收口决策（R003/R006/R007/R008/R011 的路由中心） */
  decideReadback(facts: ReadbackFacts): ReadbackDecision;
  /** 连续失败是否已达 24 小时（R005；账号禁用不使用该等待期，由调用方直接收口） */
  isBeyond24Hours(failedSince: Date, now: Date): boolean;
  /** 指数退避（封顶），供任务调度计算 nextRetryAt */
  nextRetryDelayMs(attempts: number): number;
}

export const PROFILE_SYNC_FAILURE_WINDOW_MS = 24 * 60 * 60 * 1000;
const BACKOFF_BASE_MS = 5 * 60 * 1000;
const BACKOFF_CAP_MS = 60 * 60 * 1000;

export class DefaultProfileSyncPolicy implements ProfileSyncPolicy {
  decideReadback(facts: ReadbackFacts): ReadbackDecision {
    if (facts.hasNewerConfirmedChange) {
      return 'READBACK_UNTRUSTWORTHY';
    }
    const readback = facts.readbackValue;
    if (readback === facts.targetValue) {
      return 'SYNCED';
    }
    if (readback === facts.priorValue) {
      return 'ROLLED_BACK';
    }
    const field = facts.field;
    if (field === 'name' || field === 'studentId') {
      return 'CONVERGE_AUTHORITATIVE';
    }
    return 'CONFLICT';
  }

  isBeyond24Hours(failedSince: Date, now: Date): boolean {
    return now.getTime() - failedSince.getTime() >= PROFILE_SYNC_FAILURE_WINDOW_MS;
  }

  nextRetryDelayMs(attempts: number): number {
    const exponential = BACKOFF_BASE_MS * Math.pow(2, Math.max(0, attempts - 1));
    return Math.min(exponential, BACKOFF_CAP_MS);
  }
}
