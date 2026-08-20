/**
 * ORG-002 Group 关系命令聚合（SRS-SM-ORG-002；模型层）。
 *
 * - 变更先进入处理中，原关系/原权限继续有效；只有 Casdoor 写入成功且回读确认后
 *   才正式生效（ORG-027）。
 * - 以「Casdoor 请求号 + 业务幂等键」幂等；同一目标处理中禁止重复/冲突操作；
 *   对象/关系版本必须匹配（SRS-SM-ORG-002）。
 * - 15 分钟有界重试 + 先回读后重试；失败维持原有效状态、通知操作人和超管、
 *   保留全部尝试审计、允许人工重试。
 * - 复合关系写入登记版本化目标关系图，按"基础/低权限 → 具体/高权限"执行，
 *   部分成功逆序补偿，未全部确认不授新权限（CAS-Q-001 方案 A、CAS-WR-013）。
 */

import type {
  GroupStableRef,
  RelationCommandStatus,
  RelationCommandType,
  RelationWriteStep,
} from '../types';

export interface RelationCommand {
  id: string;
  clubId: string;
  type: RelationCommandType;
  subjectId: string;
  /** 原关系快照（版本化目标关系图；未生效时继续有效，ORG-027） */
  originalRelation: ReadonlyArray<RelationWriteStep>;
  /** 目标关系图（按 order 升序执行：基础/低权限 → 具体/高权限） */
  targetRelation: ReadonlyArray<RelationWriteStep>;
  status: RelationCommandStatus;
  commandVersion: number;
  objectVersion: number;
  idempotencyKey: string;
  casdoorRequestId: string | null;
  /** 自动重试截止（15 分钟窗口；ORG-027） */
  retryDeadline: string | null;
  attemptCount: number;
  submittedBy: string;
  submittedAt: string;
  confirmedAt: string | null;
  failureReason: string | null;
  notices: string[];
}

export function createRelationCommand(input: {
  id: string;
  clubId: string;
  type: RelationCommandType;
  subjectId: string;
  originalRelation: RelationWriteStep[];
  targetRelation: RelationWriteStep[];
  objectVersion: number;
  idempotencyKey: string;
  submittedBy: string;
  now: Date;
}): RelationCommand {
  return {
    id: input.id,
    clubId: input.clubId,
    type: input.type,
    subjectId: input.subjectId,
    originalRelation: input.originalRelation,
    targetRelation: input.targetRelation,
    status: 'pending_execution',
    commandVersion: 1,
    objectVersion: input.objectVersion,
    idempotencyKey: input.idempotencyKey,
    casdoorRequestId: null,
    retryDeadline: null,
    attemptCount: 0,
    submittedBy: input.submittedBy,
    submittedAt: input.now.toISOString(),
    confirmedAt: null,
    failureReason: null,
    notices: [],
  };
}

export function targetGroupsOf(command: RelationCommand): GroupStableRef[] {
  return command.targetRelation.map((s) => s.targetGroup);
}
