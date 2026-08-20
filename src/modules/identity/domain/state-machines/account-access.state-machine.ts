/**
 * IDN-001 账号访问状态机（SRS-SM-IDN-001，6 条转换；IFC-SM-001）。
 *
 * 状态：有效（ACTIVE）/ 禁用（DISABLED）/ 删除（DELETED）/ Casdoor 暂不可确认（UNVERIFIABLE）。
 *
 * 转换表（SRS-SM-IDN-001 R001~R006）：
 *  R001 有效 → 禁用：Casdoor 禁用事件/对账确认（重复禁用幂等，仅返回既有结果）
 *  R002 有效 → 删除：Casdoor 删除事件/对账确认（删除优先于普通资料或业务写竞争）
 *  R003 有效 → 暂不可确认：Casdoor 调用或对账确认当前状态暂不可确认（记录降级起点，
 *       同一故障窗口合并；单次可重试错误未达故障判定时不得提前降级）
 *  R004 暂不可确认 → 有效/禁用/删除：恢复并回读账号状态（以可验证的 Casdoor 当前状态
 *       收口；读回仍不确定时保持降级，不返回假恢复）
 *  R005 禁用 → 有效：Casdoor 恢复账号并对账确认有效（要求重新登录；不自动恢复已结束
 *       业务/已撤销任务/历史角色）
 *  R006 暂不可确认 → 暂不可确认：15 分钟窗口内执行最小白名单操作（白名单判定由
 *       DegradationPolicy 给出，本机守卫只依据判定结果放行/拒绝）
 *
 * 守卫要点（SRS 原文）：
 * - 事件无效、账号不匹配或无法确认时不改为禁用/删除，保持有效并进入审计/对账；
 * - 无法确认删除时不得猜测删除；
 *  - 恢复与禁用/删除事件竞争时以可验证的 Casdoor 当前状态为准。
 */

export const AccountAccessState = {
  ACTIVE: 'ACTIVE',
  DISABLED: 'DISABLED',
  DELETED: 'DELETED',
  UNVERIFIABLE: 'UNVERIFIABLE',
} as const;
export type AccountAccessState = (typeof AccountAccessState)[keyof typeof AccountAccessState];

export const AccountAccessEvent = {
  /** R001 有效→禁用（事件/对账） */
  CASDOOR_DISABLED: 'CASDOOR_DISABLED',
  /** R002 有效→删除（事件/对账） */
  CASDOOR_DELETED: 'CASDOOR_DELETED',
  /** R003 有效→暂不可确认（故障判定） */
  CASDOOR_UNVERIFIABLE: 'CASDOOR_UNVERIFIABLE',
  /** R004 暂不可确认→回读收口 */
  READBACK_RECOVERED: 'READBACK_RECOVERED',
  /** R005 禁用→有效（恢复并重新登录） */
  ACCOUNT_REENABLED: 'ACCOUNT_REENABLED',
  /** R006 降级窗口内白名单操作（自环） */
  WHITELIST_OPERATION: 'WHITELIST_OPERATION',
} as const;
export type AccountAccessEvent = (typeof AccountAccessEvent)[keyof typeof AccountAccessEvent];

/** 降级白名单命令类别（IDN-009/SRS-FAIL-001；判定在 DegradationPolicy） */
export type DegradationCommandCategory =
  'PUBLIC_PAGE' | 'OWN_BASIC_PROFILE_READ' | 'OWN_EXISTING_DRAFT_EDIT';

export interface WhitelistVerdict {
  /** 是否允许执行该降级白名单命令 */
  readonly allowed: boolean;
  /** 拒绝原因（最小可披露） */
  readonly reason: string | null;
}

export interface AccountAccessTransitionInput {
  readonly event: AccountAccessEvent;
  readonly currentState: AccountAccessState;
  /** R004 可信回读到的账号当前状态 */
  readonly readbackState?: AccountAccessState;
  /** R006 降级白名单判定结果（由 DegradationPolicy 计算，服务端判定、客户端不可延长） */
  readonly whitelistVerdict?: WhitelistVerdict;
}

export interface AccountAccessTransitionResult {
  readonly allowed: boolean;
  /** 转换后的状态（拒绝时为当前状态） */
  readonly nextState: AccountAccessState;
  /** 是否要求立即终止本地会话（禁用/删除） */
  readonly sessionRevoke: boolean;
  /** 恢复后是否要求重新认证（禁用→有效） */
  readonly reauthenticationRequired: boolean;
  readonly reason: string | null;
}

function reject(currentState: AccountAccessState, reason: string): AccountAccessTransitionResult {
  return {
    allowed: false,
    nextState: currentState,
    sessionRevoke: false,
    reauthenticationRequired: false,
    reason,
  };
}

function accept(
  nextState: AccountAccessState,
  options: { sessionRevoke?: boolean; reauthenticationRequired?: boolean } = {},
): AccountAccessTransitionResult {
  return {
    allowed: true,
    nextState,
    sessionRevoke: options.sessionRevoke ?? false,
    reauthenticationRequired: options.reauthenticationRequired ?? false,
    reason: null,
  };
}

export interface AccountAccessStateMachine {
  transition(input: AccountAccessTransitionInput): AccountAccessTransitionResult;
}

export class DefaultAccountAccessStateMachine implements AccountAccessStateMachine {
  transition(input: AccountAccessTransitionInput): AccountAccessTransitionResult {
    switch (input.event) {
      case AccountAccessEvent.CASDOOR_DISABLED: {
        if (input.currentState === AccountAccessState.ACTIVE) {
          return accept(AccountAccessState.DISABLED, { sessionRevoke: true });
        }
        if (input.currentState === AccountAccessState.DISABLED) {
          // 重复禁用幂等：只返回既有结果（SRS-SM-IDN-001 R001）
          return accept(AccountAccessState.DISABLED);
        }
        return reject(
          input.currentState,
          '账号不处于有效状态，禁用事件不适用（删除后不得猜测禁用；降级中须以回读收口）',
        );
      }
      case AccountAccessEvent.CASDOOR_DELETED: {
        if (input.currentState === AccountAccessState.ACTIVE) {
          return accept(AccountAccessState.DELETED, { sessionRevoke: true });
        }
        if (input.currentState === AccountAccessState.DELETED) {
          // 重复删除幂等：只返回既有结果（R002）
          return accept(AccountAccessState.DELETED);
        }
        return reject(
          input.currentState,
          '账号不处于有效状态，删除事件不适用（删除优先于普通写竞争，但不得猜测删除）',
        );
      }
      case AccountAccessEvent.CASDOOR_UNVERIFIABLE: {
        if (input.currentState !== AccountAccessState.ACTIVE) {
          return reject(input.currentState, '仅有效账号可进入 Casdoor 暂不可确认降级');
        }
        return accept(AccountAccessState.UNVERIFIABLE);
      }
      case AccountAccessEvent.READBACK_RECOVERED: {
        if (input.currentState !== AccountAccessState.UNVERIFIABLE) {
          return reject(input.currentState, '回读收口仅适用于 Casdoor 暂不可确认状态');
        }
        if (
          input.readbackState !== AccountAccessState.ACTIVE &&
          input.readbackState !== AccountAccessState.DISABLED &&
          input.readbackState !== AccountAccessState.DELETED
        ) {
          return reject(input.currentState, '回读结果不可用时不返回假恢复');
        }
        const sessionRevoke =
          input.readbackState === AccountAccessState.DISABLED ||
          input.readbackState === AccountAccessState.DELETED;
        const reauthenticationRequired = input.readbackState === AccountAccessState.ACTIVE;
        return accept(input.readbackState, { sessionRevoke, reauthenticationRequired });
      }
      case AccountAccessEvent.ACCOUNT_REENABLED: {
        if (input.currentState !== AccountAccessState.DISABLED) {
          return reject(
            input.currentState,
            '仅禁用状态可恢复；账号仍禁用/已删除/无法确认时保持原状态',
          );
        }
        return accept(AccountAccessState.ACTIVE, { reauthenticationRequired: true });
      }
      case AccountAccessEvent.WHITELIST_OPERATION: {
        if (input.currentState !== AccountAccessState.UNVERIFIABLE) {
          return reject(input.currentState, '白名单操作仅适用于降级窗口内的暂不可确认账号');
        }
        if (!input.whitelistVerdict || !input.whitelistVerdict.allowed) {
          return reject(input.currentState, input.whitelistVerdict?.reason ?? '白名单命令被拒绝');
        }
        return accept(AccountAccessState.UNVERIFIABLE);
      }
      default:
        return reject(input.currentState, '未知账号访问事件');
    }
  }
}
