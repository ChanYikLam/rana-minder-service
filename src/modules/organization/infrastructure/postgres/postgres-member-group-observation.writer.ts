/**
 * PostgreSQL 成员 Group 关系观测写入（infrastructure；A4 Group 写链路收口）。
 *
 * 数据权威：Casdoor 当前 Group 关系（membership Casdoor 写链路 + 对账任务刷新）；
 * 本写入器把 membership 域的"已回读确认"关系快照落入本地观测表
 * org_member_group_current（CAS-MAP-004 关系观测），让权限解析路径
 * （PostgresCurrentPermissionsPort 读 org_member_group_current）在不回访 Casdoor 的
 * 前提下解析当前关系。生产/灰度路径走该实现；ORG_DB_REAL=0 时由
 * GOV-007 守卫拒绝构造。
 */

import type { DbAdapter, TransactionContext } from '../../../../shared/db-adapter';
import type {
  MemberGroupObservationWriter,
  MemberGroupRelationObservation,
} from '../../application/ports';

const ORG_RLS_SCOPE: { kind: 'unprotected' } = { kind: 'unprotected' };

export class PostgresMemberGroupObservationWriter implements MemberGroupObservationWriter {
  constructor(private readonly db: DbAdapter) {}

  async upsertCurrentRelations(
    subjectId: string,
    relations: readonly MemberGroupRelationObservation[],
  ): Promise<void> {
    if (relations.length === 0) return;
    let tx: TransactionContext | null = null;
    try {
      tx = await this.db.beginTransaction();
      await this.db.setRlsContext(tx, ORG_RLS_SCOPE);
      // ON CONFLICT 按 (subject_id, group_owner, group_name) PK 合并；写入即视为当前权威观测。
      // observed_at 始终刷新为 now()——观测表只保留"最新一次确认"的时间戳。
      for (const r of relations) {
        await this.db.query(
          tx,
          `INSERT INTO org_member_group_current
             (subject_id, group_owner, group_name, club_id, department_id, purpose, observed_at)
           VALUES ($1, $2, $3, $4, $5, $6, now())
           ON CONFLICT (subject_id, group_owner, group_name) DO UPDATE SET
             club_id = EXCLUDED.club_id,
             department_id = EXCLUDED.department_id,
             purpose = EXCLUDED.purpose,
             observed_at = now()`,
          [subjectId, r.groupOwner, r.groupName, r.clubId, r.departmentId, r.purpose],
        );
      }
      await this.db.commit(tx);
    } catch (error) {
      if (tx !== null) {
        await this.db.rollback(tx).catch(() => undefined);
      }
      throw error;
    } finally {
      if (tx !== null) {
        await this.db.clearRlsContext(tx).catch(() => undefined);
      }
    }
  }

  async removeCurrentRelationsForClub(
    subjectId: string,
    clubId: string,
    purpose: 'club' | 'department' | 'position',
  ): Promise<void> {
    let tx: TransactionContext | null = null;
    try {
      tx = await this.db.beginTransaction();
      await this.db.setRlsContext(tx, ORG_RLS_SCOPE);
      await this.db.query(
        tx,
        `DELETE FROM org_member_group_current
          WHERE subject_id = $1 AND club_id = $2 AND purpose = $3`,
        [subjectId, clubId, purpose],
      );
      await this.db.commit(tx);
    } catch (error) {
      if (tx !== null) {
        await this.db.rollback(tx).catch(() => undefined);
      }
      throw error;
    } finally {
      if (tx !== null) {
        await this.db.clearRlsContext(tx).catch(() => undefined);
      }
    }
  }
}
