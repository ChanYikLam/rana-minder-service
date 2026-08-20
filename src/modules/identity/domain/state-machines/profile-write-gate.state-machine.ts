/**
 * IDN-002 资料写入门状态机（SRS-SM-IDN-002，8 条转换；IFC-SM-002）。
 *
 * 状态：待补充（PENDING_COMPLETION）/ 待邮箱验证（PENDING_EMAIL_VERIFICATION）/
 * 可写（WRITABLE）/ 分范围受限（PARTIALLY_RESTRICTED）。
 *
 * 复合派生门：主体必填完备 + 邮箱验证 + 分范围限制集合共同派生；当前状态由
 * ProfileGatePolicy 重算，本状态机对事件执行守卫并落位派生结果（IDN-010 原子重算）。
 *
 * 转换表（SRS-SM-IDN-002 R001~R008）：
 *  R001 待补充 → 待补充/待邮箱验证：保存平台公共资料（仅允许字段；白名单字段进入
 *       同步状态机；重新计算全部资料门）
 *  R002 待补充 → 待邮箱验证/可写：补齐最后一项平台必填（不得因资料完成绕过未验证邮箱）
 *  R003 待邮箱验证 → 待邮箱验证：发送/重发验证邮件（邮箱有效、重发频率允许、平台发信
 *       能力可用；不改变当前有效邮箱）
 *  R004 待邮箱验证 → 待邮箱验证：验证链接超 24 小时或被新请求取代（原子使链接失效，
 *       旧有效邮箱保持）
 *  R005 待邮箱验证 → 可写/分范围受限：验证链接成功（单次令牌；若为邮箱更换则替换旧
 *       有效邮箱并进入同步；重新计算全部资料门）
 *  R006 可写 → 待补充：平台新必填字段到达生效日且本人未补齐（立即关闭除补资料外的
 *       业务写入；保留全部读取权限）
 *  R007 可写 → 分范围受限：社团成员资料或某次报名资料缺失/补充期限生效（缺失只影响
 *       一个社团或一次报名；作用域键唯一、多限制并集生效）
 *  R008 分范围受限 → 可写/分范围受限：补齐特定范围资料或限制被合法撤销（原子关闭已
 *       满足的限制；不得扩大其他范围权限）
 *
 * 守卫要点：字段版本竞争（新必填字段生效与用户补齐提交以同一版本边界重算）；
 * 并发新增限制不能被旧请求清除（R008）。
 */

import { allowTransition, rejectTransition, type StateTransitionResult } from './transition-result';

export const ProfileWriteGateState = {
  PENDING_COMPLETION: 'PENDING_COMPLETION',
  PENDING_EMAIL_VERIFICATION: 'PENDING_EMAIL_VERIFICATION',
  WRITABLE: 'WRITABLE',
  PARTIALLY_RESTRICTED: 'PARTIALLY_RESTRICTED',
} as const;
export type ProfileWriteGateState =
  (typeof ProfileWriteGateState)[keyof typeof ProfileWriteGateState];

export const ProfileWriteGateEvent = {
  /** R001 保存平台公共资料 */
  SAVE_PLATFORM_PROFILE: 'SAVE_PLATFORM_PROFILE',
  /** R002 补齐最后一项平台必填 */
  COMPLETE_LAST_REQUIRED: 'COMPLETE_LAST_REQUIRED',
  /** R003 发送/重发验证邮件 */
  SEND_VERIFICATION_EMAIL: 'SEND_VERIFICATION_EMAIL',
  /** R004 验证链接过期或被新请求取代 */
  VERIFICATION_EXPIRED_OR_SUPERSEDED: 'VERIFICATION_EXPIRED_OR_SUPERSEDED',
  /** R005 验证链接成功 */
  VERIFICATION_SUCCESS: 'VERIFICATION_SUCCESS',
  /** R006 平台新必填字段到达生效日且未补齐 */
  NEW_REQUIRED_FIELD_EFFECTIVE: 'NEW_REQUIRED_FIELD_EFFECTIVE',
  /** R007 社团/报名范围缺失生效 */
  SCOPE_REQUIREMENT_MISSING: 'SCOPE_REQUIREMENT_MISSING',
  /** R008 补齐特定范围或限制被撤销 */
  SCOPE_REQUIREMENT_SATISFIED: 'SCOPE_REQUIREMENT_SATISFIED',
} as const;
export type ProfileWriteGateEvent =
  (typeof ProfileWriteGateEvent)[keyof typeof ProfileWriteGateEvent];

export interface ProfileWriteGateTransitionInput {
  readonly event: ProfileWriteGateEvent;
  readonly currentState: ProfileWriteGateState;
  /** 事件后由 ProfileGatePolicy 重算的派生门状态（R001/R002/R005/R008 落位用） */
  readonly derivedNextState?: ProfileWriteGateState;
  /** R003 守卫：邮箱格式有效 */
  readonly emailValid?: boolean;
  /** R003 守卫：重发频率允许 */
  readonly resendAllowed?: boolean;
  /** R003 守卫：平台发信能力可用 */
  readonly mailCapable?: boolean;
  /** R006 守卫：字段已发布且生效 */
  readonly fieldEffective?: boolean;
  /** R006 守卫：当前值缺失 */
  readonly valueMissing?: boolean;
  /** R008 守卫：该范围要求已满足 */
  readonly scopeSatisfied?: boolean;
}

export interface ProfileWriteGateStateMachine {
  transition(input: ProfileWriteGateTransitionInput): StateTransitionResult<ProfileWriteGateState>;
}

export class DefaultProfileWriteGateStateMachine implements ProfileWriteGateStateMachine {
  transition(input: ProfileWriteGateTransitionInput): StateTransitionResult<ProfileWriteGateState> {
    const g = ProfileWriteGateState;
    switch (input.event) {
      case ProfileWriteGateEvent.SAVE_PLATFORM_PROFILE: {
        if (input.currentState !== g.PENDING_COMPLETION) {
          return rejectTransition(g.PENDING_COMPLETION, '仅待补充状态可保存平台公共资料');
        }
        if (!input.derivedNextState) {
          return rejectTransition(g.PENDING_COMPLETION, '资料门重算结果缺失');
        }
        return allowTransition(input.derivedNextState);
      }
      case ProfileWriteGateEvent.COMPLETE_LAST_REQUIRED: {
        if (input.currentState !== g.PENDING_COMPLETION) {
          return rejectTransition(g.PENDING_COMPLETION, '仅待补充状态可补齐最后一项必填');
        }
        if (!input.derivedNextState) {
          return rejectTransition(g.PENDING_COMPLETION, '资料门重算结果缺失');
        }
        // 不得因资料完成绕过未验证邮箱：派生结果由 ProfileGatePolicy 保证
        return allowTransition(input.derivedNextState);
      }
      case ProfileWriteGateEvent.SEND_VERIFICATION_EMAIL: {
        if (input.currentState !== g.PENDING_EMAIL_VERIFICATION) {
          return rejectTransition(g.PENDING_EMAIL_VERIFICATION, '仅待邮箱验证状态可发送验证邮件');
        }
        if (!input.emailValid) {
          return rejectTransition(g.PENDING_EMAIL_VERIFICATION, '邮箱格式无效');
        }
        if (!input.resendAllowed) {
          return rejectTransition(g.PENDING_EMAIL_VERIFICATION, '重发频率超限');
        }
        if (!input.mailCapable) {
          return rejectTransition(g.PENDING_EMAIL_VERIFICATION, '平台发信能力不可用');
        }
        return allowTransition(g.PENDING_EMAIL_VERIFICATION);
      }
      case ProfileWriteGateEvent.VERIFICATION_EXPIRED_OR_SUPERSEDED: {
        if (input.currentState !== g.PENDING_EMAIL_VERIFICATION) {
          return rejectTransition(
            g.PENDING_EMAIL_VERIFICATION,
            '仅待邮箱验证状态的链接会过期或被取代',
          );
        }
        return allowTransition(g.PENDING_EMAIL_VERIFICATION);
      }
      case ProfileWriteGateEvent.VERIFICATION_SUCCESS: {
        if (input.currentState !== g.PENDING_EMAIL_VERIFICATION) {
          return rejectTransition(g.PENDING_EMAIL_VERIFICATION, '仅待邮箱验证状态可成功验证');
        }
        if (!input.derivedNextState) {
          return rejectTransition(g.PENDING_EMAIL_VERIFICATION, '资料门重算结果缺失');
        }
        return allowTransition(input.derivedNextState);
      }
      case ProfileWriteGateEvent.NEW_REQUIRED_FIELD_EFFECTIVE: {
        if (input.currentState !== g.WRITABLE) {
          return rejectTransition(g.WRITABLE, '仅可写状态受新必填字段生效影响');
        }
        if (!input.fieldEffective) {
          return rejectTransition(g.WRITABLE, '字段尚未生效，不转换');
        }
        if (!input.valueMissing) {
          return rejectTransition(g.WRITABLE, '字段已补齐，不转换');
        }
        return allowTransition(g.PENDING_COMPLETION);
      }
      case ProfileWriteGateEvent.SCOPE_REQUIREMENT_MISSING: {
        if (input.currentState !== g.WRITABLE) {
          return rejectTransition(g.WRITABLE, '仅可写状态可新增分范围限制');
        }
        return allowTransition(g.PARTIALLY_RESTRICTED);
      }
      case ProfileWriteGateEvent.SCOPE_REQUIREMENT_SATISFIED: {
        if (input.currentState !== g.PARTIALLY_RESTRICTED) {
          return rejectTransition(g.PARTIALLY_RESTRICTED, '仅分范围受限状态可解除限制');
        }
        if (!input.scopeSatisfied) {
          return rejectTransition(g.PARTIALLY_RESTRICTED, '该范围要求未满足，拒绝解除');
        }
        if (!input.derivedNextState) {
          return rejectTransition(g.PARTIALLY_RESTRICTED, '资料门重算结果缺失');
        }
        // 其他范围限制并存时保持分范围受限；否则回到可写
        return allowTransition(input.derivedNextState);
      }
      default:
        return rejectTransition(input.currentState, '未知资料写入门事件');
    }
  }
}
