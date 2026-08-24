/**
 * ClubStore PostgreSQL 实现（#68 / ADR-014）。
 *
 * 乐观锁：事务内读 version → 应用层比对（incoming < existing → IFC-ERR-007，
 * 与内存桩逐字对齐）→ upsert。真实 PG 行级并发收窄随 ADR-005 RLS 细化升级。
 */

import type { DbAdapter } from '../../../../shared/db-adapter';
import type { ClubSpace } from '../../domain/models/club-space';
import type { ClubStore } from '../../application/ports';
import type { GroupStableRef } from '../../domain/types';
import { orgError } from '../../domain/types';
import { ORG_RLS_SCOPE, OrgUnitOfWork } from './org-unit-of-work';

export class PostgresClubStore implements ClubStore {
  constructor(
    private readonly db: DbAdapter,
    private readonly uow: OrgUnitOfWork,
  ) {}

  async save(club: ClubSpace): Promise<void> {
    await this.uow.run(ORG_RLS_SCOPE, async () => {
      const tx = this.uow.active;
      const existing = await this.db.query<{ version: number }>(
        tx,
        'SELECT version FROM org_club_space WHERE id = $1',
        [club.id],
      );
      if (existing[0] !== undefined && club.version < existing[0].version) {
        throw orgError.stateConflict(
          `检测到旧版本写入，拒绝回退覆盖（乐观锁，IFC-ERR-007）${club.id}`,
        );
      }
      await this.db.query(
        tx,
        `INSERT INTO org_club_space (id, version, club_group_owner, club_group_name, payload)
         VALUES ($1, $2, $3, $4, $5::jsonb)
         ON CONFLICT (id) DO UPDATE SET
           version = $2, club_group_owner = $3, club_group_name = $4, payload = $5::jsonb`,
        [
          club.id,
          club.version,
          club.clubGroup?.owner ?? null,
          club.clubGroup?.name ?? null,
          JSON.stringify(club),
        ],
      );
    });
  }

  private async queryOne(clubId: string): Promise<ClubSpace | null> {
    let result: ClubSpace | null = null;
    await this.uow.run(ORG_RLS_SCOPE, async () => {
      const rows = await this.db.query<{ payload: ClubSpace }>(
        this.uow.active,
        'SELECT payload FROM org_club_space WHERE id = $1',
        [clubId],
      );
      result = rows[0]?.payload ?? null;
    });
    return result;
  }

  async findById(id: string): Promise<ClubSpace | null> {
    return this.queryOne(id);
  }

  async list(): Promise<ClubSpace[]> {
    let rows: Array<{ payload: ClubSpace }> = [];
    await this.uow.run(ORG_RLS_SCOPE, async () => {
      rows = await this.db.query<{ payload: ClubSpace }>(
        this.uow.active,
        'SELECT payload FROM org_club_space',
        [],
      );
    });
    return rows.map((r) => r.payload);
  }

  async findByGroupRef(ref: GroupStableRef): Promise<ClubSpace | null> {
    let result: ClubSpace | null = null;
    await this.uow.run(ORG_RLS_SCOPE, async () => {
      const rows = await this.db.query<{ payload: ClubSpace }>(
        this.uow.active,
        'SELECT payload FROM org_club_space WHERE club_group_owner = $1 AND club_group_name = $2 LIMIT 1',
        [ref.owner, ref.name],
      );
      result = rows[0]?.payload ?? null;
    });
    return result;
  }
}
