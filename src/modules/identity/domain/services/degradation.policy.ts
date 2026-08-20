/**
 * IDN-009/SRS-FAIL-001 Casdoor 15 分钟故障降级策略。
 *
 * 服务端判定：故障起点与会话可信时间由服务端决定，客户端不可延长（IDN-009）；
 * 本策略为纯规则，只接受时间戳与命令类别。
 *
 * 白名单（SRS-FAIL-001）：
 * - 原本无需登录的公开页面（PUBLIC_PAGE）；
 * - 本人基础资料只读（OWN_BASIC_PROFILE_READ）；
 * - 编辑并保存故障前已经存在的本人表单草稿非附件字段（OWN_EXISTING_DRAFT_EDIT）。
 *
 * 拒绝项：新登录、超过 15 分钟、非本人、草稿非故障前已存在、含附件操作、
 * 新建草稿、修改个人资料、正式提交、通知详情、邀请/审批、任何状态变化、
 * 管理/跨社团/导出/配置/安全操作、恢复已撤销权限、本地后门（CAS-FAIL-001）。
 *
 * 边界：
 * - 会话在故障前已可信登录，且故障持续时间 ≤ 15 分钟，才允许白名单命令；
 * - 15 分钟后除公开页面外全部受保护请求关闭；
 * - 恢复后必须先可信回读账号再重算授权，不复活旧权限。
 */

export const DEGRADATION_WINDOW_MS = 15 * 60 * 1000;

export type DegradationCommandCategory =
  'PUBLIC_PAGE' | 'OWN_BASIC_PROFILE_READ' | 'OWN_EXISTING_DRAFT_EDIT';

export const DegradationCommandCategory = {
  PUBLIC_PAGE: 'PUBLIC_PAGE',
  OWN_BASIC_PROFILE_READ: 'OWN_BASIC_PROFILE_READ',
  OWN_EXISTING_DRAFT_EDIT: 'OWN_EXISTING_DRAFT_EDIT',
} as const;

export interface DegradationInput {
  /** 故障起点（服务端判定） */
  readonly degradedSince: Date;
  /** 当前时刻 */
  readonly now: Date;
  /** 会话是否在故障前已可信登录 */
  readonly sessionAuthenticatedBeforeFailure: boolean;
  /** 命令类别；非白名单类别视为受保护业务 */
  readonly category: DegradationCommandCategory | 'PROTECTED_BUSINESS';
}

export interface DegradationVerdict {
  readonly allowed: boolean;
  /** 剩余窗口毫秒数（窗口外为 0） */
  readonly remainingMs: number;
  /** 是否处于降级窗口内 */
  readonly withinWindow: boolean;
  /** 拒绝原因（最小可披露） */
  readonly reason: string | null;
}

export interface DegradationPolicy {
  /** 剩余窗口毫秒数（时钟回拨按 0 保守处理） */
  remainingWindowMs(degradedSince: Date, now: Date): number;
  /** 完整白名单判定（服务端逐请求调用，客户端不得复用旧判定） */
  evaluate(input: DegradationInput): DegradationVerdict;
}

export class DefaultDegradationPolicy implements DegradationPolicy {
  remainingWindowMs(degradedSince: Date, now: Date): number {
    const elapsed = now.getTime() - degradedSince.getTime();
    if (elapsed < 0) {
      // 时钟回拨：保守按已超窗处理，不以过期时间假装新鲜
      return 0;
    }
    return Math.max(0, DEGRADATION_WINDOW_MS - elapsed);
  }

  evaluate(input: DegradationInput): DegradationVerdict {
    const remainingMs = this.remainingWindowMs(input.degradedSince, input.now);
    const withinWindow = remainingMs > 0;

    if (input.category === 'PUBLIC_PAGE') {
      return { allowed: true, remainingMs, withinWindow, reason: null };
    }
    if (!withinWindow) {
      return {
        allowed: false,
        remainingMs: 0,
        withinWindow: false,
        reason: '故障窗口已超过 15 分钟，仅公开页面可用',
      };
    }
    if (!input.sessionAuthenticatedBeforeFailure) {
      return {
        allowed: false,
        remainingMs,
        withinWindow: true,
        reason: '会话未在故障前可信登录，不授予白名单',
      };
    }
    if (
      input.category === 'OWN_BASIC_PROFILE_READ' ||
      input.category === 'OWN_EXISTING_DRAFT_EDIT'
    ) {
      return { allowed: true, remainingMs, withinWindow, reason: null };
    }
    return {
      allowed: false,
      remainingMs,
      withinWindow: true,
      reason: '降级窗口内禁止受保护业务操作',
    };
  }
}
