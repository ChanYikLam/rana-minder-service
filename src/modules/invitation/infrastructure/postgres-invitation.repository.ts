/**
 * PostgreSQL 邀请仓储（infrastructure；4.5 REC-024~028 持久化）。
 *
 * 表：invitations / routine_invitations（列与迁移 20260822100000 逐列对齐）。
 * - 待处理唯一性由部分唯一索引 `invitations_pending_unique` 强制（MEM-018）；
 *   唯一冲突（SQLSTATE 23505）映射 IFC-ERR-009（IFC-GEN-007 幂等冲突）。
 * - 单胜者竞争 compareAndSwap 以 `WHERE version=$expected` 条件更新实现，
 *   影响行数≠1 即竞争失败返回 false（REC-026 接受不可逆的前提保障）。
 * - 本模块无共享 UnitOfWork（命令直接调仓储），每个方法内部自管短事务
 *   （begin → query → commit/rollback）；RLS 首版 unprotected
 *   （与 RecruitmentUnitOfWork 同口径，隔离细化待 3.x 落地后跟进）。
 * - JSONB 字段读写兼容 PG（对象）与内存测试替身（字符串）两种载荷。
 */

import type { DbAdapter } from '../../../shared/db-adapter';
import type {
  Invitation,
  MemberActivationIntention,
  InvitationHistoryEvent,
} from '../domain/models/invitation';
import type { RoutineInvitation } from '../domain/models/routine-invitation';
import type { InvitationRepository } from './invitation-repository';
import type { RoutineInvitationRepository } from './routine-invitation-repository';
import { Injectable } from '@nestjs/common';

/**
 * 幂等冲突（IFC-ERR-009）：同社团同对象已存在待处理邀请（MEM-018）。
 * 由仓储将 PostgreSQL 部分唯一索引冲突（SQLSTATE 23505）映射为该领域错误，
 * 供控制器 instanceof 识别并映射为约定 HTTP 状态。
 */
export class InvitationUniqueViolationError extends Error {
  readonly code = 'IFC-ERR-009';
  constructor(message = '同社团同对象已存在待处理邀请（IFC-ERR-009 幂等冲突）') {
    super(`IFC-ERR-009: ${message}`);
    this.name = 'InvitationUniqueViolationError';
  }
}

interface InvitationRow {
  invitation_id: string;
  kind: string;
  invitee_id: string;
  club_id: string;
  issuer_id: string;
  decision_ref: string | null;
  reissued_from_id: string | null;
  status: string;
  version: string | number;
  created_at: Date;
  expires_at: Date;
  accepted_at: Date | null;
  activation_json: unknown;
  history_json: unknown;
}

interface RoutineRow {
  routine_invitation_id: string;
  invitee_id: string;
  club_id: string;
  department_id: string | null;
  issuer_id: string;
  status: string;
  version: string | number;
  created_at: Date;
  expires_at: Date;
  accepted_at: Date | null;
  activated_at: Date | null;
  relation_targets: unknown;
  sync_status: unknown;
  attempt_count: number;
  last_error: string | null;
  history_json: unknown;
}

/** JSONB 载荷兼容：PG 返回对象、内存替身可能返回字符串 */
function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return JSON.parse(value) as Record<string, unknown>;
  return value as Record<string, unknown>;
}

function asArray(value: unknown): unknown[] {
  const record = asRecord(value);
  if (Array.isArray(value)) return value;
  if (Array.isArray(record)) return record;
  return [];
}

function iso(value: Date | null): string | null {
  return value === null ? null : value.toISOString();
}

function toDate(isoString: string): Date {
  return new Date(isoString);
}

@Injectable()
export class PostgresInvitationRepository implements InvitationRepository {
  constructor(private readonly db: DbAdapter) {}

  async save(invitation: Invitation): Promise<void> {
    const tx = await this.db.beginTransaction();
    try {
      await this.db
        .query(
          tx,
          `INSERT INTO public.invitations (
           invitation_id, kind, invitee_id, club_id, issuer_id, decision_ref,
           reissued_from_id, status, version, created_at, expires_at, accepted_at,
           activation_json, history_json
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
         ON CONFLICT (invitation_id) DO UPDATE SET
           status = EXCLUDED.status,
           version = EXCLUDED.version,
           accepted_at = EXCLUDED.accepted_at,
           activation_json = EXCLUDED.activation_json,
           history_json = EXCLUDED.history_json`,
          [
            invitation.invitationId,
            invitation.kind,
            invitation.inviteeId,
            invitation.clubId,
            invitation.issuerId,
            invitation.decisionRef,
            invitation.reissuedFromId,
            invitation.status,
            invitation.version,
            toDate(invitation.createdAt),
            toDate(invitation.expiresAt),
            invitation.acceptedAt === null ? null : toDate(invitation.acceptedAt),
            JSON.stringify(invitation.activation ?? null),
            JSON.stringify(invitation.history),
          ],
        )
        .catch((error: unknown) => {
          throw mapUniqueViolation(error);
        });
      await this.db.commit(tx);
    } catch (error) {
      await this.db.rollback(tx).catch(() => undefined);
      throw error;
    } finally {
      await this.db.clearRlsContext(tx).catch(() => undefined);
    }
  }

  async load(invitationId: string): Promise<Invitation | null> {
    const tx = await this.db.beginTransaction();
    try {
      const rows = await this.db.query<InvitationRow>(
        tx,
        `SELECT * FROM public.invitations WHERE invitation_id = $1`,
        [invitationId],
      );
      await this.db.commit(tx);
      return rows.length === 0 ? null : rowToInvitation(rows[0]);
    } catch (error) {
      await this.db.rollback(tx).catch(() => undefined);
      throw error;
    } finally {
      await this.db.clearRlsContext(tx).catch(() => undefined);
    }
  }

  async findPending(clubId: string, inviteeId: string): Promise<Invitation | null> {
    const tx = await this.db.beginTransaction();
    try {
      const rows = await this.db.query<InvitationRow>(
        tx,
        `SELECT * FROM public.invitations
         WHERE club_id = $1 AND invitee_id = $2 AND status = 'PENDING'
         LIMIT 1`,
        [clubId, inviteeId],
      );
      await this.db.commit(tx);
      return rows.length === 0 ? null : rowToInvitation(rows[0]);
    } catch (error) {
      await this.db.rollback(tx).catch(() => undefined);
      throw error;
    } finally {
      await this.db.clearRlsContext(tx).catch(() => undefined);
    }
  }

  async compareAndSwap(current: Invitation, next: Invitation): Promise<boolean> {
    const tx = await this.db.beginTransaction();
    try {
      const rows = await this.db.query<{ invitation_id: string }>(
        tx,
        `UPDATE public.invitations SET
           status = $2, version = $3, accepted_at = $4,
           activation_json = $5, history_json = $6
         WHERE invitation_id = $7 AND version = $8
         RETURNING invitation_id`,
        [
          current.invitationId,
          next.status,
          next.version,
          next.acceptedAt === null ? null : toDate(next.acceptedAt),
          JSON.stringify(next.activation ?? null),
          JSON.stringify(next.history),
          current.invitationId,
          current.version,
        ],
      );
      await this.db.commit(tx);
      return rows.length === 1;
    } catch (error) {
      await this.db.rollback(tx).catch(() => undefined);
      throw error;
    } finally {
      await this.db.clearRlsContext(tx).catch(() => undefined);
    }
  }
}

@Injectable()
export class PostgresRoutineInvitationRepository implements RoutineInvitationRepository {
  constructor(private readonly db: DbAdapter) {}

  async save(invitation: RoutineInvitation): Promise<void> {
    const tx = await this.db.beginTransaction();
    try {
      await this.db
        .query(
          tx,
          `INSERT INTO public.routine_invitations (
           routine_invitation_id, invitee_id, club_id, department_id, issuer_id,
           status, version, created_at, expires_at, accepted_at, activated_at,
           relation_targets, sync_status, attempt_count, last_error, history_json
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
         ON CONFLICT (routine_invitation_id) DO UPDATE SET
           status = EXCLUDED.status,
           version = EXCLUDED.version,
           accepted_at = EXCLUDED.accepted_at,
           activated_at = EXCLUDED.activated_at,
           relation_targets = EXCLUDED.relation_targets,
           sync_status = EXCLUDED.sync_status,
           attempt_count = EXCLUDED.attempt_count,
           last_error = EXCLUDED.last_error,
           history_json = EXCLUDED.history_json`,
          [
            invitation.routineInvitationId,
            invitation.inviteeId,
            invitation.clubId,
            invitation.initialDepartmentId,
            invitation.issuerId,
            invitation.status,
            invitation.version,
            toDate(invitation.createdAt),
            toDate(invitation.expiresAt),
            invitation.acceptedAt === null ? null : toDate(invitation.acceptedAt),
            invitation.activatedAt === null ? null : toDate(invitation.activatedAt),
            JSON.stringify(invitation.relationTargets),
            JSON.stringify(invitation.syncStatus ?? null),
            invitation.attemptCount,
            invitation.lastError ?? null,
            JSON.stringify(invitation.history),
          ],
        )
        .catch((error: unknown) => {
          throw mapUniqueViolation(error);
        });
      await this.db.commit(tx);
    } catch (error) {
      await this.db.rollback(tx).catch(() => undefined);
      throw error;
    } finally {
      await this.db.clearRlsContext(tx).catch(() => undefined);
    }
  }

  async load(routineInvitationId: string): Promise<RoutineInvitation | null> {
    const tx = await this.db.beginTransaction();
    try {
      const rows = await this.db.query<RoutineRow>(
        tx,
        `SELECT * FROM public.routine_invitations WHERE routine_invitation_id = $1`,
        [routineInvitationId],
      );
      await this.db.commit(tx);
      return rows.length === 0 ? null : rowToRoutine(rows[0]);
    } catch (error) {
      await this.db.rollback(tx).catch(() => undefined);
      throw error;
    } finally {
      await this.db.clearRlsContext(tx).catch(() => undefined);
    }
  }

  async findPending(clubId: string, inviteeId: string): Promise<RoutineInvitation | null> {
    const tx = await this.db.beginTransaction();
    try {
      const rows = await this.db.query<RoutineRow>(
        tx,
        `SELECT * FROM public.routine_invitations
         WHERE club_id = $1 AND invitee_id = $2 AND status IN ('SENT','PENDING_ACCEPTANCE','PENDING')
         LIMIT 1`,
        [clubId, inviteeId],
      );
      await this.db.commit(tx);
      return rows.length === 0 ? null : rowToRoutine(rows[0]);
    } catch (error) {
      await this.db.rollback(tx).catch(() => undefined);
      throw error;
    } finally {
      await this.db.clearRlsContext(tx).catch(() => undefined);
    }
  }

  async compareAndSwap(current: RoutineInvitation, next: RoutineInvitation): Promise<boolean> {
    const tx = await this.db.beginTransaction();
    try {
      const rows = await this.db.query<{ routine_invitation_id: string }>(
        tx,
        `UPDATE public.routine_invitations SET
           status = $2, version = $3, accepted_at = $4, activated_at = $5,
           relation_targets = $6, sync_status = $7, attempt_count = $8,
           last_error = $9, history_json = $10
         WHERE routine_invitation_id = $11 AND version = $12
         RETURNING routine_invitation_id`,
        [
          current.routineInvitationId,
          next.status,
          next.version,
          next.acceptedAt === null ? null : toDate(next.acceptedAt),
          next.activatedAt === null ? null : toDate(next.activatedAt),
          JSON.stringify(next.relationTargets),
          JSON.stringify(next.syncStatus ?? null),
          next.attemptCount,
          next.lastError ?? null,
          JSON.stringify(next.history),
          current.routineInvitationId,
          current.version,
        ],
      );
      await this.db.commit(tx);
      return rows.length === 1;
    } catch (error) {
      await this.db.rollback(tx).catch(() => undefined);
      throw error;
    } finally {
      await this.db.clearRlsContext(tx).catch(() => undefined);
    }
  }
}

// ----- 内部 -----

function mapUniqueViolation(error: unknown): Error {
  const err = error as { code?: string; constraint?: string };
  if (err?.code === '23505') {
    // MEM-018：同社团同对象最多一份待处理邀请（IFC-ERR-009 幂等冲突）
    return new InvitationUniqueViolationError();
  }
  return error as Error;
}

function rowToInvitation(row: InvitationRow): Invitation {
  const activationRaw = asRecord(row.activation_json);
  const activation: MemberActivationIntention | null = activationRaw
    ? {
        intentionId: String(activationRaw['intentionId'] ?? ''),
        invitationId: String(activationRaw['invitationId'] ?? row.invitation_id),
        memberEffectiveAt: String(activationRaw['memberEffectiveAt'] ?? ''),
        status: activationRaw['status'] as MemberActivationIntention['status'],
        attemptCount: Number(activationRaw['attemptCount'] ?? 0),
        lastError:
          typeof activationRaw['lastError'] === 'string' ? activationRaw['lastError'] : undefined,
        lastAttemptAt:
          typeof activationRaw['lastAttemptAt'] === 'string'
            ? activationRaw['lastAttemptAt']
            : undefined,
      }
    : null;
  return {
    invitationId: row.invitation_id,
    kind: row.kind as Invitation['kind'],
    inviteeId: row.invitee_id,
    clubId: row.club_id,
    issuerId: row.issuer_id,
    decisionRef: row.decision_ref,
    reissuedFromId: row.reissued_from_id,
    status: row.status as Invitation['status'],
    version: Number(row.version),
    createdAt: iso(row.created_at)!,
    expiresAt: iso(row.expires_at)!,
    acceptedAt: iso(row.accepted_at),
    activation,
    history: asArray(row.history_json) as readonly InvitationHistoryEvent[],
  };
}

function rowToRoutine(row: RoutineRow): RoutineInvitation {
  return {
    routineInvitationId: row.routine_invitation_id,
    inviteeId: row.invitee_id,
    clubId: row.club_id,
    initialDepartmentId: row.department_id,
    issuerId: row.issuer_id,
    status: row.status as RoutineInvitation['status'],
    version: Number(row.version),
    createdAt: iso(row.created_at)!,
    expiresAt: iso(row.expires_at)!,
    acceptedAt: iso(row.accepted_at),
    activatedAt: iso(row.activated_at),
    relationTargets: asArray(row.relation_targets) as RoutineInvitation['relationTargets'],
    syncStatus: (asRecord(row.sync_status) as RoutineInvitation['syncStatus']) ?? null,
    attemptCount: row.attempt_count,
    lastError: row.last_error ?? undefined,
    history: asArray(row.history_json) as RoutineInvitation['history'],
  };
}
