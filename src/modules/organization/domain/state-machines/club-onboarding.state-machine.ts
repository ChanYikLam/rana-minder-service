/**
 * SRS-SM-ORG-001 社团接入状态机（10 条转换；IFC-SM-004）。
 *
 * 权威语义：docs/specification/SRS-状态机转换明细-v1.0.md §4.1。
 *
 * 转换策略：
 * - 纯转换责任：本状态机只裁决"该事件在当前状态下是否允许、目标状态为何、
 *   需并置哪些原子副作用标签"；守卫输入（真实业务事实）由用例层从端口读取后传入。
 * - 状态不变 = 命令被拒绝（抛 OrgDomainError，IFC-ERR-007/006/002/008）。
 * - 修复/重绑/重新接入/重新启用是独立命令：前三者统一只到已停用，只有 re-enable
 *   才恢复普通访问（ORG-009/010）。
 * - 仅改名不进入异常（ORG-026）；删除/移动/失权才进入同步异常只读（ORG-013）。
 */

import type {
  ClubSpace,
  MappingHistoryEntry,
  StatusHistoryEntry,
  SyncEvent,
} from '../models/club-space';
import type { ClubStatus } from '../types';
import { orgError } from '../types';

export type ClubEvent =
  | 'wizard_save_step'
  | 'wizard_complete'
  | 'normal_suspend'
  | 'force_suspend'
  | 'recover'
  | 'reconcile_anomaly'
  | 'repair'
  | 'rebind'
  | 'reaccess'
  | 'disconnect';

export interface ClubTransitionInput {
  club: ClubSpace;
  event: ClubEvent;
  actor: string;
  now: Date;
  /** 业务前置事实（用例层从端口读取后传入） */
  facts: {
    /** 候选或当前 Group 是否可读（阻止改名误判：仅改名不视为异常，ORG-026） */
    groupReadable?: boolean;
    /** 原映射 Group 是否被删除/移动/失权（ORG-013） */
    anomalyDetected?: boolean;
    /** 是否存在进行中招新/有效邀请/审批（ORG-028） */
    hasActiveBusiness?: boolean;
    /** 高风控命令的二次确认（ORG-004/005/009） */
    confirmed?: boolean;
    /** 负责人连续性校验结果（ORG-024） */
    leaderContinuityOk?: boolean;
    /** 是否存在不可变业务历史（决定解除接入目标，ORG-008/009） */
    hasHistory?: boolean;
    /** 实际受阻时长（恢复时由 FreezeExtensionService 计算，ORG-028） */
    freezeDurationMs?: number;
    /** wizard_complete 时最终确认的负责人职位 Group（ORG-024） */
    leaderCandidate?: { owner: string; name: string };
    /** 重绑/重新接入时的新 Group 稳定映射（ORG-009/010） */
    newGroupRef?: { owner: string; name: string };
  };
}

export interface ClubTransitionResult {
  club: ClubSpace;
  /** 本次转换必须原子落库的副作用标签（IFC-TX-001/002） */
  readonly requiredSideEffects: string[];
  /** 本次转换追加的同步事件 */
  readonly events: SyncEvent[];
}

function statusText(status: ClubStatus): string {
  switch (status) {
    case 'wizard_pending':
      return '向导未完成';
    case 'enabled':
      return '已启用';
    case 'suspended':
      return '已停用';
    case 'sync_abnormal_readonly':
      return '同步异常只读';
    case 'pending_reaccess':
      return '待重新接入';
  }
}

export class ClubOnboardingStateMachine {
  /** 转换表（事件 -> 允许的当前状态；供测试与审计列示） */
  static readonly TABLE: Readonly<Record<ClubEvent, readonly ClubStatus[]>> = {
    wizard_save_step: ['wizard_pending'],
    wizard_complete: ['wizard_pending'],
    normal_suspend: ['enabled'],
    force_suspend: ['enabled'],
    recover: ['suspended'],
    reconcile_anomaly: ['enabled', 'suspended'],
    repair: ['sync_abnormal_readonly'],
    rebind: ['sync_abnormal_readonly'],
    reaccess: ['pending_reaccess'],
    disconnect: ['wizard_pending', 'sync_abnormal_readonly'],
  };

  private allowedFrom(event: ClubEvent, status: ClubStatus): boolean {
    return ClubOnboardingStateMachine.TABLE[event].includes(status);
  }

  transition(input: ClubTransitionInput): ClubTransitionResult {
    const { club, event, actor, now, facts } = input;
    const stamp = now.toISOString();

    if (!this.allowedFrom(event, club.status)) {
      throw orgError.stateConflict(
        `社团当前状态 ${club.status} 不允许执行 ${event}（IFC-ERR-007）`,
      );
    }

    const updated: ClubSpace = { ...club, version: club.version + 1 };
    const events: SyncEvent[] = [];
    const statusHistory: StatusHistoryEntry[] = [];
    const mappingHistory: MappingHistoryEntry[] = [];
    let sideEffects: string[] = [];

    const appendStatus = (to: ClubStatus, note: string, evName: string) => {
      statusHistory.push({ from: updated.status, to, event: evName, at: stamp, actor, note });
    };

    switch (event) {
      case 'wizard_save_step': {
        updated.wizardStep = Math.min(updated.wizardStep + 1, 5);
        sideEffects = ['save_wizard_draft', 'config_audit'];
        break;
      }

      case 'wizard_complete': {
        if (facts.confirmed !== true) {
          throw orgError.reauth('完成接入需二次确认（ORG-004/005；IFC-ERR-002）');
        }
        if (facts.leaderContinuityOk !== true) {
          throw orgError.precondition('须至少一个负责人职位 Group 且至少一名有效负责人（ORG-024）');
        }
        updated.status = 'enabled';
        updated.readonly = false;
        updated.boundAt = stamp;
        updated.wizardClosed = false;
        updated.clubGroup = updated.wizardCandidate ?? updated.clubGroup;
        if (facts.leaderCandidate) updated.leaderGroup = facts.leaderCandidate;
        appendStatus('enabled', '接入校验通过，社团已启用', 'wizard_complete');
        mappingHistory.push({
          mappingVersion: updated.mappingVersion + 1,
          previous: null,
          next: updated.clubGroup,
          kind: 'bind',
          at: stamp,
          actor,
        });
        updated.mappingVersion += 1;
        sideEffects = [
          'publish_mapping',
          'bind_group',
          'import_existing_relations_unknown_dates',
          'status_audit',
        ];
        break;
      }

      case 'normal_suspend': {
        if (facts.hasActiveBusiness === true) {
          throw orgError.precondition(
            '仍有进行中招新/有效邀请/审批，普通停用被阻止（ORG-028）',
            'activeBusiness',
          );
        }
        updated.status = 'suspended';
        updated.readonly = true;
        updated.forcedSuspension = false;
        if (updated.freezeStart === null) updated.freezeStart = stamp;
        events.push({
          id: `gev-suspend-${updated.version}`,
          kind: 'suspend',
          at: stamp,
          note: '普通停用（可恢复）',
          actor,
        });
        appendStatus('suspended', '普通停用（可恢复）', 'normal_suspend');
        sideEffects = ['set_readonly', 'preserve_casdoor_relations', 'status_audit'];
        break;
      }

      case 'force_suspend': {
        if (facts.confirmed !== true) {
          throw orgError.reauth(
            '紧急强制停用需填写原因、影响预览与二次确认（ORG-028；IFC-ERR-002）',
          );
        }
        updated.status = 'suspended';
        updated.readonly = true;
        updated.forcedSuspension = true;
        if (updated.freezeStart === null) updated.freezeStart = stamp;
        events.push({
          id: `gev-forcesuspend-${updated.version}`,
          kind: 'force_suspend',
          at: stamp,
          note: '紧急强制停用（暂停自动截止/超时）',
          actor,
        });
        appendStatus('suspended', '紧急强制停用（暂停自动截止/超时）', 'force_suspend');
        sideEffects = [
          'set_readonly',
          'pause_auto_deadlines',
          'notify_affected',
          'preserve_casdoor_relations',
          'status_audit',
        ];
        break;
      }

      case 'recover': {
        if (facts.leaderContinuityOk !== true) {
          throw orgError.precondition('重新启用须满足负责人连续性（ORG-024）');
        }
        const duration = facts.freezeDurationMs ?? 0;
        updated.status = 'enabled';
        updated.readonly = false;
        updated.forcedSuspension = false;
        updated.freezeExtensionMs += duration; // 按实际受阻时长一次性顺延、不重复延长（ORG-028）
        updated.freezeStart = null; // 结算当前受阻区间
        events.push({
          id: `gev-recover-${updated.version}`,
          kind: 'recover',
          at: stamp,
          note: '重新启用',
          actor,
        });
        appendStatus('enabled', '重新启用：恢复普通角色访问并按受阻时长顺延冻结期限', 'recover');
        sideEffects = [
          'unset_readonly',
          'extend_frozen_deadlines',
          'notify_affected',
          'status_audit',
        ];
        break;
      }

      case 'reconcile_anomaly': {
        if (facts.anomalyDetected !== true) {
          throw orgError.precondition(
            '未可靠检测到 Group 删除/移动/失权，不得进入同步异常（ORG-013）',
          );
        }
        updated.status = 'sync_abnormal_readonly';
        updated.readonly = true;
        updated.forcedSuspension = false;
        if (updated.freezeStart === null) updated.freezeStart = stamp;
        events.push({
          id: `gev-lost-${updated.version}`,
          kind: 'group_lost',
          at: stamp,
          note: 'Group 删除/移动/失权，进入同步异常只读',
          actor,
        });
        appendStatus(
          'sync_abnormal_readonly',
          '同步异常只读（保留历史与原映射、冻结期限）',
          'reconcile_anomaly',
        );
        sideEffects = [
          'set_readonly',
          'close_position_permissions',
          'freeze_business_deadlines',
          'notify_super_admin',
          'status_audit',
        ];
        break;
      }

      case 'repair': {
        if (facts.groupReadable !== true) {
          throw orgError.precondition('原 Group 未恢复可读，无法修复；请改走重新绑定（ORG-010）');
        }
        if (facts.leaderContinuityOk !== true) {
          throw orgError.precondition('修复后负责人连续性校验失败（ORG-024）');
        }
        updated.status = 'suspended';
        updated.readonly = true;
        updated.forcedSuspension = false;
        updated.freezeStart = stamp; // 重置受阻起点，避免重复结算（ORG-028）
        events.push({
          id: `gev-repair-${updated.version}`,
          kind: 'repair',
          at: stamp,
          note: '修复原 Group 并对账通过，统一进入已停用（仍需另行重新启用）',
          actor,
        });
        appendStatus('suspended', '修复完成 → 已停用（未恢复访问）', 'repair');
        mappingHistory.push({
          mappingVersion: updated.mappingVersion,
          previous: updated.clubGroup ? { ...updated.clubGroup } : null,
          next: updated.clubGroup,
          kind: 'repair',
          at: stamp,
          actor,
        });
        sideEffects = ['close_mapping_anomaly', 'preserve_freeze_interval', 'status_audit'];
        break;
      }

      case 'rebind': {
        if (facts.confirmed !== true) {
          throw orgError.reauth('重新绑定需影响预览与二次确认（ORG-009；IFC-ERR-002）');
        }
        if (facts.leaderContinuityOk !== true) {
          throw orgError.precondition('重绑后负责人连续性校验失败（ORG-024）');
        }
        if (facts.newGroupRef === undefined) {
          throw orgError.precondition('重新绑定必须指定新 Group（ORG-009）');
        }
        updated.status = 'suspended';
        updated.readonly = true;
        updated.forcedSuspension = false;
        updated.clubGroup = facts.newGroupRef;
        updated.freezeStart = stamp; // 重置受阻起点，避免重复结算（ORG-028）
        // 新组绑定后职位/部门需重新配置，避免静默扩大权限（GOV-007）
        updated.leaderGroup = null;
        updated.leaderRoleGroup = null;
        updated.departmentGroups = [];
        updated.positionGroups = [];
        events.push({
          id: `gev-rebind-${updated.version}`,
          kind: 'rebind',
          at: stamp,
          note: '重新绑定新 Group，统一进入已停用（未恢复访问）',
          actor,
        });
        appendStatus('suspended', '重新绑定完成 → 已停用（未恢复访问）', 'rebind');
        mappingHistory.push({
          mappingVersion: updated.mappingVersion + 1,
          previous: club.clubGroup,
          next: facts.newGroupRef,
          kind: 'rebind',
          at: stamp,
          actor,
        });
        updated.mappingVersion += 1;
        sideEffects = [
          'replace_mapping',
          'close_mapping_anomaly',
          'preserve_freeze_interval',
          'status_audit',
        ];
        break;
      }

      case 'reaccess': {
        if (facts.confirmed !== true) {
          throw orgError.reauth('重新接入需完整校验与二次确认（ORG-009；IFC-ERR-002）');
        }
        if (facts.leaderContinuityOk !== true) {
          throw orgError.precondition('重新接入后负责人连续性校验失败（ORG-024）');
        }
        if (facts.newGroupRef === undefined) {
          throw orgError.precondition('重新接入必须指定新 Group（ORG-009）');
        }
        updated.status = 'suspended';
        updated.readonly = true;
        updated.forcedSuspension = false;
        updated.clubGroup = facts.newGroupRef;
        updated.freezeStart = stamp; // 重置受阻起点，避免重复结算（ORG-028）
        events.push({
          id: `gev-reaccess-${updated.version}`,
          kind: 'reaccess',
          at: stamp,
          note: '重新接入，统一进入已停用（仍需独立重新启用）',
          actor,
        });
        appendStatus('suspended', '重新接入完成 → 已停用（未恢复访问）', 'reaccess');
        mappingHistory.push({
          mappingVersion: updated.mappingVersion + 1,
          previous: club.clubGroup,
          next: facts.newGroupRef,
          kind: 'reaccess',
          at: stamp,
          actor,
        });
        updated.mappingVersion += 1;
        sideEffects = [
          'restore_mapping',
          'preserve_history',
          'preserve_freeze_interval',
          'status_audit',
        ];
        break;
      }

      case 'disconnect': {
        if (facts.hasHistory === true) {
          updated.status = 'pending_reaccess';
          updated.readonly = true;
        } else {
          updated.wizardClosed = true;
          updated.status = 'wizard_pending';
        }
        updated.clubGroup = null;
        updated.leaderGroup = null;
        updated.leaderRoleGroup = null;
        updated.departmentGroups = [];
        updated.positionGroups = [];
        events.push({
          id: `gev-disconnect-${updated.version}`,
          kind: 'disconnect',
          at: stamp,
          note: '解除接入（不删除 Casdoor Group，历史保留）',
          actor,
        });
        appendStatus(updated.status, statusText(updated.status), 'disconnect');
        mappingHistory.push({
          mappingVersion: updated.mappingVersion,
          previous: club.clubGroup,
          next: null,
          kind: 'disconnect',
          at: stamp,
          actor,
        });
        sideEffects = ['revoke_mapping', 'preserve_history', 'notify_admin', 'status_audit'];
        break;
      }

      default: {
        const exhaustive: never = event;
        throw orgError.stateConflict(`未支持的事件 ${String(exhaustive)}（IFC-ERR-007）`);
      }
    }

    updated.syncEvents = [...updated.syncEvents, ...events];
    updated.statusHistory = [...updated.statusHistory, ...statusHistory];
    updated.mappingHistory = [...updated.mappingHistory, ...mappingHistory];
    return { club: updated, requiredSideEffects: sideEffects, events };
  }
}
