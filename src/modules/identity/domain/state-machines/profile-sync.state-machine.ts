/**
 * IDN-003 资料同步状态机（SRS-SM-IDN-003，12 条转换；IFC-SM-003）。
 *
 * 状态：已同步（SYNCED）/ 待同步（PENDING_SYNC）/ 重试中（RETRYING）/
 * 待读回核验（PENDING_READBACK_VERIFICATION）/ 已回退（ROLLED_BACK）/
 * 同步冲突待本人选择（CONFLICT_PENDING_USER_CHOICE）/ 人工处理（MANUAL_INTERVENTION）。
 *
 * 转换表（SRS-SM-IDN-003 R001~R012）：
 *  R001 已同步 → 待同步：本地保存白名单字段合法新值（原子保存本地新值、修改前有效值、
 *       同步意图；本地立即展示新值；以用户+字段+目标版本+幂等键去重）
 *  R002 待同步 → 重试中：启动 Casdoor 写入（记录尝试与请求号；不得覆盖更晚本地版本）
 *  R003 重试中 → 已同步：写入并回读确认目标值（重复成功回调返回原结果；旧回调不覆盖
 *       新同步版本）
 *  R004 待同步/重试中 → 重试中：临时失败且未满 24 小时（保存尝试次数/下次重试/脱敏错误）
 *  R005 重试中 → 待读回核验：连续 24 小时仍失败（原子冻结盲目写重试并创建强制读回任务；
 *       单个字段版本只创建一个读回任务）
 *  R006 待读回核验 → 已同步：回读确认 Casdoor 已是目标值
 *  R007 待读回核验 → 已回退：回读确认 Casdoor 仍为修改前有效值（先可信读回才可回退，
 *       防止把已成功写入制造成不一致）
 *  R008 待读回核验 → 同步冲突待本人选择：普通可编辑字段读回第三值（保存修改前值/本地
 *       目标值/Casdoor 第三值/读回时间/可验证版本/冲突版本；停止该目标版本自动写入与
 *       回退；本地目标值继续作为当前显示值并附冲突标记）
 *  R009 冲突待本人选择 → 待同步：本人选择保留本地目标值（提交前重新可信读回且与快照
 *       一致；创建新资料版本、新同步意图和新幂等键；不在本地事务伪造 Casdoor 已写入）
 *  R010 冲突待本人选择 → 已同步：本人选择接受 Casdoor 当前值（更新本地当前值为经本人
 *       确认的 Casdoor 值；保留全部历史；不得改写既有业务快照）
 *  R011 待读回核验 → 已同步：姓名/学号等只读权威字段读回第三值（直接收敛为 Casdoor
 *       当前值，不进入本人选择；保留旧值/失败目标/外部新值/来源与全部尝试）
 *  R012 已回退/待读回核验 → 待同步/人工处理：有权人工处理并重新发起同步（必须创建新
 *       版本和新幂等键；不得重放旧请求制造重复写）
 */

import { allowTransition, rejectTransition, type StateTransitionResult } from './transition-result';

export const ProfileSyncState = {
  SYNCED: 'SYNCED',
  PENDING_SYNC: 'PENDING_SYNC',
  RETRYING: 'RETRYING',
  PENDING_READBACK_VERIFICATION: 'PENDING_READBACK_VERIFICATION',
  ROLLED_BACK: 'ROLLED_BACK',
  CONFLICT_PENDING_USER_CHOICE: 'CONFLICT_PENDING_USER_CHOICE',
  MANUAL_INTERVENTION: 'MANUAL_INTERVENTION',
} as const;
export type ProfileSyncState = (typeof ProfileSyncState)[keyof typeof ProfileSyncState];

export const ProfileSyncEvent = {
  /** R001 本地保存白名单字段合法新值 */
  LOCAL_SAVE: 'LOCAL_SAVE',
  /** R002 启动 Casdoor 写入 */
  START_WRITE: 'START_WRITE',
  /** R003 写入并回读确认目标值 */
  WRITE_CONFIRMED: 'WRITE_CONFIRMED',
  /** R004 临时失败且未满 24 小时 */
  TRANSIENT_FAILURE: 'TRANSIENT_FAILURE',
  /** R005 连续 24 小时仍失败 */
  TWENTY_FOUR_HOUR_FAILURE: 'TWENTY_FOUR_HOUR_FAILURE',
  /** R006 回读确认 Casdoor 已是目标值 */
  READBACK_TARGET: 'READBACK_TARGET',
  /** R007 回读确认 Casdoor 仍为修改前有效值 */
  READBACK_ORIGINAL: 'READBACK_ORIGINAL',
  /** R008 普通可编辑字段读回第三值 */
  READBACK_THIRD_VALUE: 'READBACK_THIRD_VALUE',
  /** R009 本人选择保留本地目标值 */
  USER_CHOICE_KEEP_LOCAL: 'USER_CHOICE_KEEP_LOCAL',
  /** R010 本人选择接受 Casdoor 当前值 */
  USER_CHOICE_ACCEPT_CASDOOR: 'USER_CHOICE_ACCEPT_CASDOOR',
  /** R011 只读权威字段读回第三值（收敛 Casdoor 当前值） */
  READBACK_AUTHORITATIVE_THIRD: 'READBACK_AUTHORITATIVE_THIRD',
  /** R012 有权人工处理并重新发起同步 */
  MANUAL_RETRY: 'MANUAL_RETRY',
} as const;
export type ProfileSyncEvent = (typeof ProfileSyncEvent)[keyof typeof ProfileSyncEvent];

export interface ProfileSyncTransitionInput {
  readonly event: ProfileSyncEvent;
  readonly currentState: ProfileSyncState;
  /** 当前同步意图是否为最新目标版本（更晚本地版本已存在时旧意图不得推进） */
  readonly isCurrentVersion?: boolean;
  /** R008 守卫：字段属于用户可直接修改的同步白名单 */
  readonly editableField?: boolean;
  /** R008 守卫：目标同步版本仍为当前版本（冲突版本比较） */
  readonly conflictVersionMatches?: boolean;
  /** R009/R010 守卫：提交前重新可信读回且与所展示快照一致 */
  readonly readbackStillMatchesSnapshot?: boolean;
  /** R012 目标：待同步或人工处理 */
  readonly retryTarget?: Extract<ProfileSyncState, 'PENDING_SYNC' | 'MANUAL_INTERVENTION'>;
}

export interface ProfileSyncStateMachine {
  transition(input: ProfileSyncTransitionInput): StateTransitionResult<ProfileSyncState>;
}

export class DefaultProfileSyncStateMachine implements ProfileSyncStateMachine {
  transition(input: ProfileSyncTransitionInput): StateTransitionResult<ProfileSyncState> {
    const s = ProfileSyncState;
    const reject = (expected: ProfileSyncState, reason: string): StateTransitionResult<ProfileSyncState> =>
      rejectTransition(expected, reason);
    const notCurrent = (): StateTransitionResult<ProfileSyncState> =>
      reject(s.PENDING_SYNC, '存在更晚本地版本，旧同步意图不得推进');

    switch (input.event) {
      case ProfileSyncEvent.LOCAL_SAVE: {
        if (input.currentState !== s.SYNCED) {
          return reject(s.SYNCED, '仅已同步状态可保存白名单字段新值（版本冲突走旧版本拒绝）');
        }
        return allowTransition(s.PENDING_SYNC);
      }
      case ProfileSyncEvent.START_WRITE: {
        if (input.currentState !== s.PENDING_SYNC) {
          return reject(s.PENDING_SYNC, '仅待同步状态可启动 Casdoor 写入');
        }
        if (input.isCurrentVersion === false) {
          return notCurrent();
        }
        return allowTransition(s.RETRYING);
      }
      case ProfileSyncEvent.WRITE_CONFIRMED: {
        if (input.currentState !== s.RETRYING) {
          return reject(s.RETRYING, '仅重试中状态可回读确认目标值');
        }
        if (input.isCurrentVersion === false) {
          return notCurrent();
        }
        return allowTransition(s.SYNCED);
      }
      case ProfileSyncEvent.TRANSIENT_FAILURE: {
        if (
          input.currentState !== s.PENDING_SYNC &&
          input.currentState !== s.RETRYING
        ) {
          return reject(s.RETRYING, '仅待同步/重试中状态可登记临时失败');
        }
        if (input.isCurrentVersion === false) {
          return notCurrent();
        }
        return allowTransition(s.RETRYING);
      }
      case ProfileSyncEvent.TWENTY_FOUR_HOUR_FAILURE: {
        if (input.currentState !== s.RETRYING) {
          return reject(s.RETRYING, '仅重试中状态可触发 24 小时核验边界');
        }
        if (input.isCurrentVersion === false) {
          return notCurrent();
        }
        return allowTransition(s.PENDING_READBACK_VERIFICATION);
      }
      case ProfileSyncEvent.READBACK_TARGET: {
        if (input.currentState !== s.PENDING_READBACK_VERIFICATION) {
          return reject(
            s.PENDING_READBACK_VERIFICATION,
            '仅待读回核验状态可回读确认目标值',
          );
        }
        if (input.isCurrentVersion === false) {
          return notCurrent();
        }
        return allowTransition(s.SYNCED);
      }
      case ProfileSyncEvent.READBACK_ORIGINAL: {
        if (input.currentState !== s.PENDING_READBACK_VERIFICATION) {
          return reject(
            s.PENDING_READBACK_VERIFICATION,
            '仅待读回核验状态可回退（回退前必须先可信读回）',
          );
        }
        if (input.isCurrentVersion === false) {
          return notCurrent();
        }
        return allowTransition(s.ROLLED_BACK);
      }
      case ProfileSyncEvent.READBACK_THIRD_VALUE: {
        if (input.currentState !== s.PENDING_READBACK_VERIFICATION) {
          return reject(
            s.PENDING_READBACK_VERIFICATION,
            '仅待读回核验状态可进入第三值冲突选择',
          );
        }
        if (input.isCurrentVersion === false) {
          return notCurrent();
        }
        if (!input.editableField) {
          return reject(
            s.PENDING_READBACK_VERIFICATION,
            '只读权威字段第三值不进入本人选择，按收敛路径处理',
          );
        }
        return allowTransition(s.CONFLICT_PENDING_USER_CHOICE);
      }
      case ProfileSyncEvent.USER_CHOICE_KEEP_LOCAL: {
        if (input.currentState !== s.CONFLICT_PENDING_USER_CHOICE) {
          return reject(s.CONFLICT_PENDING_USER_CHOICE, '仅冲突待本人选择状态可保留本地值');
        }
        if (input.conflictVersionMatches === false) {
          return reject(s.CONFLICT_PENDING_USER_CHOICE, '冲突版本不匹配，拒绝并刷新比较');
        }
        if (!input.readbackStillMatchesSnapshot) {
          return reject(
            s.CONFLICT_PENDING_USER_CHOICE,
            '提交前重新读回与快照不一致，拒绝并刷新比较',
          );
        }
        return allowTransition(s.PENDING_SYNC);
      }
      case ProfileSyncEvent.USER_CHOICE_ACCEPT_CASDOOR: {
        if (input.currentState !== s.CONFLICT_PENDING_USER_CHOICE) {
          return reject(s.CONFLICT_PENDING_USER_CHOICE, '仅冲突待本人选择状态可接受 Casdoor 值');
        }
        if (input.conflictVersionMatches === false) {
          return reject(s.CONFLICT_PENDING_USER_CHOICE, '冲突版本不匹配，拒绝并刷新比较');
        }
        if (!input.readbackStillMatchesSnapshot) {
          return reject(
            s.CONFLICT_PENDING_USER_CHOICE,
            '提交前重新读回与快照不一致，拒绝并刷新比较',
          );
        }
        return allowTransition(s.SYNCED);
      }
      case ProfileSyncEvent.READBACK_AUTHORITATIVE_THIRD: {
        if (input.currentState !== s.PENDING_READBACK_VERIFICATION) {
          return reject(
            s.PENDING_READBACK_VERIFICATION,
            '仅待读回核验状态可收敛只读权威字段',
          );
        }
        if (input.isCurrentVersion === false) {
          return notCurrent();
        }
        if (input.editableField) {
          return reject(
            s.PENDING_READBACK_VERIFICATION,
            '可编辑字段第三值必须进入本人选择',
          );
        }
        return allowTransition(s.SYNCED);
      }
      case ProfileSyncEvent.MANUAL_RETRY: {
        if (
          input.currentState !== s.ROLLED_BACK &&
          input.currentState !== s.PENDING_READBACK_VERIFICATION
        ) {
          return reject(
            s.ROLLED_BACK,
            '仅已回退/待读回核验状态可人工处理并重新发起同步',
          );
        }
        if (input.retryTarget !== s.PENDING_SYNC && input.retryTarget !== s.MANUAL_INTERVENTION) {
          return reject(s.ROLLED_BACK, '人工处置目标必须是待同步或人工处理');
        }
        return allowTransition(input.retryTarget);
      }
      default:
        return reject(input.currentState, '未知资料同步事件');
    }
  }
}
