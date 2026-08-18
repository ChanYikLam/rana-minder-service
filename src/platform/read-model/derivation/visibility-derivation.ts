import type { VisitorType } from '../contracts';

/**
 * 可见性派生输入（来自权威对象当前行 + 服务端时刻，IFC-QRY-009.3）。
 * "正在报名"按查询时公开资格、通道开放、无暂停/终态覆盖且截止晚于
 * 服务端时刻共同派生；它不是持久状态或个人报名资格。
 */
export interface VisibilityInput {
  /** 发布状态（源对象权威字段） */
  readonly published: boolean;
  /** 报名通道开放 */
  readonly channelOpen: boolean;
  /** 活动暂停 */
  readonly paused: boolean;
  /** 终态覆盖（已结束/已终止等） */
  readonly terminated: boolean;
  /** 有效截止时间（服务端半开区间语义：截止晚于服务端时刻才有效） */
  readonly deadlineAt?: string;
  /** 服务端当前时刻（ISO 8601，可信时钟） */
  readonly now: string;
  /** 当前访问者类型 */
  readonly visitor: VisitorType;
}

export const VisibilityOutcome = {
  VISIBLE: 'VISIBLE',
  NOT_PUBLISHED: 'NOT_PUBLISHED',
  CHANNEL_CLOSED: 'CHANNEL_CLOSED',
  PAUSED: 'PAUSED',
  TERMINATED: 'TERMINATED',
  DEADLINE_PASSED: 'DEADLINE_PASSED',
  NOT_VISIBLE_FOR_VISITOR: 'NOT_VISIBLE_FOR_VISITOR',
} as const;

export type VisibilityOutcome = (typeof VisibilityOutcome)[keyof typeof VisibilityOutcome];

export interface VisibilityResult {
  readonly visible: boolean;
  readonly outcome: VisibilityOutcome;
  /** 按访问者类型裁剪后的可见字段键集合（字段投影，DATA-DER-002） */
  readonly projectedFields: readonly string[];
}

/**
 * 可见性派生规则（read-model README §6.3、IFC-QRY-009.2/.3）。
 *
 * 纯函数：根据发布状态、访问者类型派生可见性与字段投影。
 * 只有发布后的普通招新、首次公布后的联合活动才能进入公开结果；
 * 公开入口输出按当前访问者类型执行字段投影。
 */
export class VisibilityDerivationRules {
  derive(input: VisibilityInput): VisibilityResult {
    if (!input.published) {
      return { visible: false, outcome: VisibilityOutcome.NOT_PUBLISHED, projectedFields: [] };
    }
    if (!input.channelOpen) {
      return { visible: false, outcome: VisibilityOutcome.CHANNEL_CLOSED, projectedFields: [] };
    }
    if (input.paused) {
      return { visible: false, outcome: VisibilityOutcome.PAUSED, projectedFields: [] };
    }
    if (input.terminated) {
      return { visible: false, outcome: VisibilityOutcome.TERMINATED, projectedFields: [] };
    }
    if (input.deadlineAt !== undefined && input.deadlineAt <= input.now) {
      return { visible: false, outcome: VisibilityOutcome.DEADLINE_PASSED, projectedFields: [] };
    }
    return {
      visible: true,
      outcome: VisibilityOutcome.VISIBLE,
      projectedFields: this.projectFields(input.visitor),
    };
  }

  private projectFields(visitor: VisitorType): readonly string[] {
    // 匿名/普通访问者只投影展示层字段；管理角色可投影更多管理字段。
    // 字段键集合的权威定义随三个具体投影（子任务6）细化。
    switch (visitor) {
      case 'CLUB_ADMIN':
      case 'PLATFORM_ADMIN':
        return ['id', 'name', 'summary', 'deadlineAt', 'status'];
      case 'CLUB_MEMBER':
      case 'AUTHENTICATED':
        return ['id', 'name', 'summary', 'deadlineAt'];
      case 'ANONYMOUS':
        return ['id', 'name', 'summary'];
      default:
        // 未识别访问者类型：最小展示字段，绝不扩大投影
        return ['id', 'name'];
    }
  }
}
