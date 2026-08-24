/**
 * RelationCommandStore / AppointmentCommandStore PostgreSQL 实现（#68 / ADR-014）。
 *
 * 乐观锁语义与内存桩逐字对齐：relation 按 attempt_count、appointment 按
 * schedule_version，incoming < existing → IFC-ERR-007。
 * in_flight 列由 save 派生维护（pending_execution/processing/processing_compensating），
 * 支撑"同一目标处理中禁止并发冲突操作"索引查询（SRS-SM-ORG-002）。
 */

import type { DbAdapter } from '../../../../shared/db-adapter';
import type { RelationCommand } from '../../domain/models/relation-command';
import type { AppointmentCommand } from '../../domain/models/appointment-command';
import type { AppointmentCommandStore, RelationCommandStore } from '../../application/ports';
import { orgError } from '../../domain/types';
import { ORG_RLS_SCOPE, OrgUnitOfWork } from './org-unit-of-work';

const RELATION_IN_FLIGHT: ReadonlySet<string> = new Set([
  'pending_execution',
  'processing',
  'processing_compensating',
]);

export class PostgresRelationCommandStore implements RelationCommandStore {
  constructor(
    private readonly db: DbAdapter,
    private readonly uow: OrgUnitOfWork,
  ) {}

  async save(command: RelationCommand): Promise<void> {
    await this.uow.run(ORG_RLS_SCOPE, async () => {
      const tx = this.uow.active;
      const existing = await this.db.query<{ attempt_count: number }>(
        tx,
        'SELECT attempt_count FROM org_relation_command WHERE id = $1',
        [command.id],
      );
      if (existing[0] !== undefined && command.attemptCount < existing[0].attempt_count) {
        throw orgError.stateConflict(
          `检测到旧版本写入，拒绝回退覆盖（乐观锁，IFC-ERR-007）${command.id}`,
        );
      }
      await this.db.query(
        tx,
        `INSERT INTO org_relation_command
           (id, attempt_count, club_id, subject_id, type, idempotency_key, in_flight, payload)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
         ON CONFLICT (id) DO UPDATE SET
           attempt_count = $2, club_id = $3, subject_id = $4, type = $5,
           idempotency_key = $6, in_flight = $7, payload = $8::jsonb`,
        [
          command.id,
          command.attemptCount,
          command.clubId,
          command.subjectId,
          command.type,
          command.idempotencyKey,
          RELATION_IN_FLIGHT.has(command.status),
          JSON.stringify(command),
        ],
      );
    });
  }

  private async queryFirst(
    sql: string,
    params: readonly unknown[],
  ): Promise<RelationCommand | null> {
    let result: RelationCommand | null = null;
    await this.uow.run(ORG_RLS_SCOPE, async () => {
      const rows = await this.db.query<{ payload: RelationCommand }>(this.uow.active, sql, params);
      result = rows[0]?.payload ?? null;
    });
    return result;
  }

  async findById(id: string): Promise<RelationCommand | null> {
    return this.queryFirst('SELECT payload FROM org_relation_command WHERE id = $1 LIMIT 1', [id]);
  }

  async findByExactIdempotencyKey(
    key: string,
    subjectId: string,
    type: string,
  ): Promise<RelationCommand | null> {
    return this.queryFirst(
      `SELECT payload FROM org_relation_command
       WHERE idempotency_key = $1 AND subject_id = $2 AND type = $3 LIMIT 1`,
      [key, subjectId, type],
    );
  }

  async findByProcessingForSubject(
    clubId: string,
    subjectId: string,
  ): Promise<RelationCommand | null> {
    return this.queryFirst(
      `SELECT payload FROM org_relation_command
       WHERE club_id = $1 AND subject_id = $2 AND in_flight = $3 LIMIT 1`,
      [clubId, subjectId, true],
    );
  }
}

export class PostgresAppointmentCommandStore implements AppointmentCommandStore {
  constructor(
    private readonly db: DbAdapter,
    private readonly uow: OrgUnitOfWork,
  ) {}

  async save(command: AppointmentCommand): Promise<void> {
    await this.uow.run(ORG_RLS_SCOPE, async () => {
      const tx = this.uow.active;
      const existing = await this.db.query<{ schedule_version: number }>(
        tx,
        'SELECT schedule_version FROM org_appointment_command WHERE id = $1',
        [command.id],
      );
      if (existing[0] !== undefined && command.scheduleVersion < existing[0].schedule_version) {
        throw orgError.stateConflict(
          `检测到旧版本写入，拒绝回退覆盖（乐观锁，IFC-ERR-007）${command.id}`,
        );
      }
      await this.db.query(
        tx,
        `INSERT INTO org_appointment_command
           (id, club_id, schedule_version, relation_command_id, payload)
         VALUES ($1, $2, $3, $4, $5::jsonb)
         ON CONFLICT (id) DO UPDATE SET
           club_id = $2, schedule_version = $3, relation_command_id = $4, payload = $5::jsonb`,
        [
          command.id,
          command.clubId,
          command.scheduleVersion,
          command.relationCommandId ?? null,
          JSON.stringify(command),
        ],
      );
    });
  }

  private async queryOneBy(column: string, value: string): Promise<AppointmentCommand | null> {
    let result: AppointmentCommand | null = null;
    await this.uow.run(ORG_RLS_SCOPE, async () => {
      const rows = await this.db.query<{ payload: AppointmentCommand }>(
        this.uow.active,
        `SELECT payload FROM org_appointment_command WHERE ${column} = $1 LIMIT 1`,
        [value],
      );
      result = rows[0]?.payload ?? null;
    });
    return result;
  }

  async findById(id: string): Promise<AppointmentCommand | null> {
    return this.queryOneBy('id', id);
  }

  async findByRelationCommandId(relationCommandId: string): Promise<AppointmentCommand | null> {
    return this.queryOneBy('relation_command_id', relationCommandId);
  }

  async listByClub(clubId: string): Promise<AppointmentCommand[]> {
    let rows: Array<{ payload: AppointmentCommand }> = [];
    await this.uow.run(ORG_RLS_SCOPE, async () => {
      rows = await this.db.query<{ payload: AppointmentCommand }>(
        this.uow.active,
        'SELECT payload FROM org_appointment_command WHERE club_id = $1',
        [clubId],
      );
    });
    return rows.map((r) => r.payload);
  }
}
