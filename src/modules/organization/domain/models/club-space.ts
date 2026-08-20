/**
 * ORG-001 社团接入聚合（SRS-SM-ORG-001；模型层）。
 *
 * - 社团运行状态仅 已启用/已停用（可恢复）；已取消'归档'功能（ORG-006/007）。
 * - 停用保留 Casdoor 关系、社团只读；强制停用记录暂停起点、暂停自动截止/超时
 *   （ORG-006、ORG-028）。
 * - 同步异常只读保留历史/原映射/冻结期限；修复/重绑/重新接入统一只到已停用，
 *   须另行重新启用（ORG-009/010）。
 * - 稳定映射绑定 owner+name 组合，不依赖名称当唯一标识（ORG-013、CAS-MAP-003/005/006）。
 * - 一个 Group 同一时刻最多绑一个社团；同一 Group 只能配置为社团/部门/职位之一
 *   （ORG-014、ORG-017、ORG-018）。
 *
 * 本文件只承载结构与不可变历史追加，不实现转换规则（见 state-machines/）。
 */

import type { GroupStableRef, ClubStatus } from '../types';

export type SyncEventKind =
  | 'group_lost'
  | 'repair'
  | 'rebind'
  | 'disconnect'
  | 'reaccess'
  | 'suspend'
  | 'force_suspend'
  | 'recover'
  | 'import';

export interface SyncEvent {
  readonly id: string;
  readonly kind: SyncEventKind;
  readonly at: string;
  readonly note: string;
  readonly actor?: string;
}

export interface MappingHistoryEntry {
  readonly mappingVersion: number;
  readonly previous: GroupStableRef | null;
  readonly next: GroupStableRef | null;
  readonly kind: 'bind' | 'rebind' | 'repair' | 'reaccess' | 'disconnect';
  readonly at: string;
  readonly actor: string;
}

export interface StatusHistoryEntry {
  readonly from: ClubStatus | 'none';
  readonly to: ClubStatus;
  readonly event: string;
  readonly at: string;
  readonly actor: string;
  readonly note: string;
}

export interface ClubSpace {
  id: string;
  name: string;
  description: string;
  status: ClubStatus;
  readonly: boolean;
  /** 强制停用正交标志（ORG-028：暂停自动截止/超时） */
  forcedSuspension: boolean;
  /** 向导进度步骤（ORG-004/005：接入向导分步保存） */
  wizardStep: number;
  /** 无历史解除接入时向导空间关闭标志（ORG-008/009） */
  wizardClosed: boolean;
  /** 稳定映射候选（向导开发阶段；未启用不产生业务权限，GOV-007） */
  wizardCandidate: GroupStableRef | null;
  /** 社团 Group 稳定映射（owner+name，ORG-013） */
  clubGroup: GroupStableRef | null;
  /** 社团负责人职位 Group（ORG-024：至少保留一名负责人） */
  leaderGroup: GroupStableRef | null;
  leaderRoleGroup: GroupStableRef | null;
  email: string | null;
  /** 配置为部门的 Group 清单（ORG-011/012/018；人工选择，不自动发现） */
  departmentGroups: GroupStableRef[];
  /** 配置为职位的 Group 清单（ORG-014/017；直属社团或位于部门下） */
  positionGroups: GroupStableRef[];
  mappingVersion: number;
  createdAt: string;
  boundAt: string | null;
  importedAt: string | null;
  importedCount: number;
  /** 最早未结算受阻起点（普通停用/强制停用/同步异常区间取并集；ORG-028） */
  freezeStart: string | null;
  /** 已按实际停用时长一次性顺延的冻结期限（ORG-028、ORG-010） */
  freezeExtensionMs: number;
  /** 当前活跃计数（供普通停用前置检查；hasActiveBusiness） */
  activeBusiness: boolean;
  syncEvents: SyncEvent[];
  mappingHistory: MappingHistoryEntry[];
  statusHistory: StatusHistoryEntry[];
  version: number;
}

export function createClubSpace(input: {
  id: string;
  name: string;
  description: string;
  candidate: GroupStableRef;
  actor: string;
  now: Date;
}): ClubSpace {
  const now = input.now.toISOString();
  return {
    id: input.id,
    name: input.name,
    description: input.description,
    status: 'wizard_pending',
    readonly: true,
    forcedSuspension: false,
    wizardStep: 1,
    wizardClosed: false,
    wizardCandidate: input.candidate,
    clubGroup: null,
    leaderGroup: null,
    leaderRoleGroup: null,
    email: null,
    departmentGroups: [],
    positionGroups: [],
    mappingVersion: 0,
    createdAt: now,
    boundAt: null,
    importedAt: null,
    importedCount: 0,
    freezeStart: null,
    freezeExtensionMs: 0,
    activeBusiness: false,
    syncEvents: [],
    mappingHistory: [],
    statusHistory: [
      {
        from: 'none',
        to: 'wizard_pending',
        event: 'wizard_create',
        at: now,
        actor: input.actor,
        note: '社团接入向导已创建（未产生业务权限）',
      },
    ],
    version: 1,
  };
}
