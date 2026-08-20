/**
 * 资料同步/读回任务登记（infrastructure；job 模块边界，ADR-004）。
 *
 * 事务发件箱：任务意图与业务状态转换同事务落库（IFC-TX-001 落库意图 →
 * job 领取执行）；job 模块按表 job_tasks 领取。任务载荷只携带稳定引用，
 * 不携带敏感正文（CAS-WR-002/003；单字段版本只创建一个读回任务）。
 */

import type { DbAdapter } from '../../../shared/db-adapter';
import type { IdentityUnitOfWork } from './unit-of-work';
import type { EditableProfileField } from '../domain/models/profile-field';
import type { ProfileSyncTaskPort } from '../application/ports/profile-sync-task.port';

export class ProfileSyncTaskWriter implements ProfileSyncTaskPort {
  constructor(
    private readonly db: DbAdapter,
    private readonly uow: IdentityUnitOfWork,
  ) {}

  async scheduleProfileSync(
    subjectId: string,
    field: EditableProfileField,
    targetVersion: number,
    intentId: string,
  ): Promise<void> {
    await this.insertTask(subjectId, field, targetVersion, intentId, 'profile_sync');
  }

  async scheduleProfileReadback(
    subjectId: string,
    field: EditableProfileField,
    targetVersion: number,
    intentId: string,
  ): Promise<void> {
    await this.insertTask(subjectId, field, targetVersion, intentId, 'profile_readback');
  }

  private async insertTask(
    subjectId: string,
    field: EditableProfileField,
    targetVersion: number,
    intentId: string,
    taskType: 'profile_sync' | 'profile_readback',
  ): Promise<void> {
    await this.db.query(
      this.uow.active,
      `INSERT INTO job_tasks (id, type, subject_id, payload, status, attempts, next_run_at, created_at)
       VALUES ($1, $2, $3, $4::jsonb, 'pending', 0, NOW(), NOW())
       ON CONFLICT DO NOTHING`,
      [
        `${taskType}:${subjectId}:${field}:${targetVersion}`,
        taskType,
        subjectId,
        JSON.stringify({ subjectId, field, targetVersion, intentId }),
      ],
    );
  }
}