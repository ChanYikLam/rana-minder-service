/**
 * ORG-003 预约管理命令聚合（SRS-SM-ORG-003；模型层）。
 *
 * - 预约任命/免职/调岗支持计划/未来执行；调度器按计划执行、单执行租约、调度幂等
 *   （ORG-039、MEM-004/MEM-010）。
 * - 执行前实时重验发起人权限/对象/社团状态/连续性/命令版本；发起人失权→暂停待
 *   重新确认；业务前置条件失效→暂停待处置（不得自动执行/重试/部分写入）。
 * - 取消与调度执行按同一命令版本竞争只一个成功；执行中/已生效后拒绝通用取消。
 * - 重新确认：现任有权管理员可按原内容重新确认（新执行时间）或取消。
 */

import type { AppointmentCommandStatus, AppointmentCommandType } from '../types';

export interface AppointmentReconfirmation {
  readonly by: string;
  readonly role: string;
  readonly at: string;
}

export interface AppointmentFailureAttempt {
  readonly at: string;
  readonly reason: string;
}

export interface AppointmentCommand {
  id: string;
  clubId: string;
  type: AppointmentCommandType;
  /** 不可改写的原命令内容（SRS-SM-ORG-003 新建行） */
  content: Readonly<Record<string, unknown>>;
  initiator: string;
  initiatorRoleAtCreate: string;
  plannedAt: string;
  createdVersion: number;
  status: AppointmentCommandStatus;
  scheduleVersion: number;
  /** 执行租约持有者（单执行租约：调度幂等，ORG-039） */
  executionLease: string | null;
  confirmedBy: string | null;
  newExecTime: string | null;
  actualEffectiveAt: string | null;
  revokedEvidence: string | null;
  preconditionSnapshot: Readonly<Array<{ name: string; ok: true | false }>> | null;
  reconfirmations: AppointmentReconfirmation[];
  failureAttempts: AppointmentFailureAttempt[];
  cancelledAt: string | null;
  cancelReason: string | null;
  cancelledBy: string | null;
  relationCommandId: string | null;
  createdAt: string;
}

export function createAppointmentCommand(input: {
  id: string;
  clubId: string;
  type: AppointmentCommandType;
  content: Record<string, unknown>;
  initiator: string;
  initiatorRoleAtCreate: string;
  plannedAt: string;
  now: Date;
}): AppointmentCommand {
  return {
    id: input.id,
    clubId: input.clubId,
    type: input.type,
    content: Object.freeze({ ...input.content }),
    initiator: input.initiator,
    initiatorRoleAtCreate: input.initiatorRoleAtCreate,
    plannedAt: input.plannedAt,
    createdVersion: 1,
    status: 'created',
    scheduleVersion: 0,
    executionLease: null,
    confirmedBy: null,
    newExecTime: null,
    actualEffectiveAt: null,
    revokedEvidence: null,
    preconditionSnapshot: null,
    reconfirmations: [],
    failureAttempts: [],
    cancelledAt: null,
    cancelReason: null,
    cancelledBy: null,
    relationCommandId: null,
    createdAt: input.now.toISOString(),
  };
}
