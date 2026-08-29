/**
 * PermissionTemplateStore / GroupMappingRegistry PostgreSQL 实现（#68 / ADR-014）。
 *
 * 模板无版本 CAS（与内存桩一致，直接 upsert）；职位绑定以 (owner,name) 唯一
 * （GOV-007：一个职位 Group 同一时刻至多一个模板绑定）；Group 稳定映射落库
 * 支撑对账与"一个 Group 仅配置一种用途"约束（ORG-011/013）。
 */

import type { DbAdapter } from '../../../../shared/db-adapter';
import type {
  PermissionTemplate,
  PositionTemplateBinding,
} from '../../domain/models/permission-template';
import type {
  GroupMappingRecord,
  GroupMappingRegistry,
  PermissionTemplateStore,
} from '../../application/ports';
import type { GroupStableRef } from '../../domain/types';
import { ORG_RLS_SCOPE, OrgUnitOfWork } from './org-unit-of-work';

export class PostgresPermissionTemplateStore implements PermissionTemplateStore {
  constructor(
    private readonly db: DbAdapter,
    private readonly uow: OrgUnitOfWork,
  ) {}

  async save(template: PermissionTemplate): Promise<void> {
    await this.uow.run(ORG_RLS_SCOPE, async () => {
      await this.db.query(
        this.uow.active,
        `INSERT INTO org_permission_template (id, payload) VALUES ($1, $2::jsonb)
         ON CONFLICT (id) DO UPDATE SET payload = $2::jsonb`,
        [template.id, JSON.stringify(template)],
      );
    });
  }

  async findById(id: string): Promise<PermissionTemplate | null> {
    let result: PermissionTemplate | null = null;
    await this.uow.run(ORG_RLS_SCOPE, async () => {
      const rows = await this.db.query<{ payload: PermissionTemplate }>(
        this.uow.active,
        'SELECT payload FROM org_permission_template WHERE id = $1 LIMIT 1',
        [id],
      );
      result = rows[0]?.payload ?? null;
    });
    return result;
  }

  async list(): Promise<PermissionTemplate[]> {
    let rows: Array<{ payload: PermissionTemplate }> = [];
    await this.uow.run(ORG_RLS_SCOPE, async () => {
      rows = await this.db.query<{ payload: PermissionTemplate }>(
        this.uow.active,
        'SELECT payload FROM org_permission_template',
        [],
      );
    });
    return rows.map((r) => r.payload);
  }

  async saveBinding(binding: PositionTemplateBinding): Promise<void> {
    await this.uow.run(ORG_RLS_SCOPE, async () => {
      // 一个职位 Group 同一时刻至多一个绑定：PK 冲突即覆盖（与内存桩语义一致）
      await this.db.query(
        this.uow.active,
        `INSERT INTO org_position_template_binding
           (position_owner, position_name, club_id, payload)
         VALUES ($1, $2, $3, $4::jsonb)
         ON CONFLICT (position_owner, position_name) DO UPDATE SET
           club_id = $3, payload = $4::jsonb`,
        [
          binding.positionGroup.owner,
          binding.positionGroup.name,
          binding.clubId,
          JSON.stringify(binding),
        ],
      );
    });
  }

  async listBindings(clubId?: string): Promise<PositionTemplateBinding[]> {
    let rows: Array<{ payload: PositionTemplateBinding }> = [];
    await this.uow.run(ORG_RLS_SCOPE, async () => {
      rows =
        clubId === undefined
          ? await this.db.query<{ payload: PositionTemplateBinding }>(
              this.uow.active,
              'SELECT payload FROM org_position_template_binding',
              [],
            )
          : await this.db.query<{ payload: PositionTemplateBinding }>(
              this.uow.active,
              'SELECT payload FROM org_position_template_binding WHERE club_id = $1',
              [clubId],
            );
    });
    return rows.map((r) => r.payload);
  }

  async removeBinding(clubId: string, positionGroup: GroupStableRef): Promise<void> {
    await this.uow.run(ORG_RLS_SCOPE, async () => {
      await this.db.query(
        this.uow.active,
        'DELETE FROM org_position_template_binding WHERE club_id = $1 AND position_owner = $2 AND position_name = $3',
        [clubId, positionGroup.owner, positionGroup.name],
      );
    });
  }
}

interface MappingRow {
  group_owner: string;
  group_name: string;
  club_id: string;
  purpose: string;
  department_id: string | null;
  position_id: string | null;
  mapping_version: number;
}

function toRecord(row: MappingRow): GroupMappingRecord {
  return {
    ref: { owner: row.group_owner, name: row.group_name },
    clubId: row.club_id,
    purpose: row.purpose as GroupMappingRecord['purpose'],
    departmentId: row.department_id,
    positionId: row.position_id,
    mappingVersion: row.mapping_version,
  };
}

export class PostgresGroupMappingRegistry implements GroupMappingRegistry {
  constructor(
    private readonly db: DbAdapter,
    private readonly uow: OrgUnitOfWork,
  ) {}

  async save(record: GroupMappingRecord): Promise<void> {
    await this.uow.run(ORG_RLS_SCOPE, async () => {
      await this.db.query(
        this.uow.active,
        `INSERT INTO org_group_mapping
           (group_owner, group_name, club_id, purpose, department_id, position_id, mapping_version)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (group_owner, group_name) DO UPDATE SET
           club_id = $3, purpose = $4, department_id = $5, position_id = $6, mapping_version = $7`,
        [
          record.ref.owner,
          record.ref.name,
          record.clubId,
          record.purpose,
          record.departmentId,
          record.positionId,
          record.mappingVersion,
        ],
      );
    });
  }

  private async queryRows(sql: string, params: readonly unknown[]): Promise<GroupMappingRecord[]> {
    let rows: MappingRow[] = [];
    await this.uow.run(ORG_RLS_SCOPE, async () => {
      rows = await this.db.query<MappingRow>(this.uow.active, sql, params);
    });
    return rows.map(toRecord);
  }

  async findByRef(ref: GroupStableRef): Promise<GroupMappingRecord | null> {
    const rows = await this.queryRows(
      'SELECT * FROM org_group_mapping WHERE group_owner = $1 AND group_name = $2 LIMIT 1',
      [ref.owner, ref.name],
    );
    return rows[0] ?? null;
  }

  async listByClub(clubId: string): Promise<GroupMappingRecord[]> {
    return this.queryRows('SELECT * FROM org_group_mapping WHERE club_id = $1', [clubId]);
  }

  async listAll(): Promise<GroupMappingRecord[]> {
    return this.queryRows('SELECT * FROM org_group_mapping', []);
  }

  async findByClubRef(
    clubId: string,
    purpose: 'club' | 'department' | 'position',
    refId: string,
  ): Promise<GroupMappingRecord | null> {
    // purpose='club' 时 mapping 仅匹配 club_id（position_id/department_id 为 NULL）；
    // department/position 则按目的对应的 refId 列匹配。
    const refColumn =
      purpose === 'department' ? 'department_id' : purpose === 'position' ? 'position_id' : null;
    const sql =
      refColumn === null
        ? 'SELECT * FROM org_group_mapping WHERE club_id = $1 AND purpose = $2 LIMIT 1'
        : 'SELECT * FROM org_group_mapping WHERE club_id = $1 AND purpose = $2 AND ' +
          refColumn +
          ' = $3 LIMIT 1';
    const params: ReadonlyArray<unknown> =
      refColumn === null ? [clubId, purpose] : [clubId, purpose, refId];
    const rows = await this.queryRows(sql, params);
    return rows[0] ?? null;
  }
}
