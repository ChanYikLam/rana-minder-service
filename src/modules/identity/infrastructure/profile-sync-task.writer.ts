/**
 * 资料同步/读回任务登记（infrastructure；job 模块边界，ADR-004）。
 *
 * 事务发件箱：任务意图与业务状态转换同事务落库（IFC-TX-001 落库意图 →
 * job 领取执行）；job 模块按表 job_tasks 领取。任务载荷只携带稳定引用，
 * 不携带敏感正文（CAS-WR-002/003；单字段版本只创建一个读回任务）。
 *
 * 联调修复（2026-08-27）：INSERT 列与 job_tasks 真实结构对齐（迁移
 * 20260820130000）：task_id/task_type/intent_id/idempotency_key/scope/source/
 * max_attempts/not_before——原语句引用不存在的 id/type/subject_id/next_run_at
 * 列，真实 PG 下任何资料保存都会 500。
 */

import type { DbAdapter } from '../../../shared/db-adapter';
import type { IdentityUnitOfWork } from './unit-of-work';
import type { EditableProfileField } from '../domain/models/profile-field';
import type { ProfileSyncTaskPort } from '../application/ports/profile-sync-task.port';

const MAX_ATTEMPTS = 5; // 与 job.maxAttempts 配置默认一致

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
    await this.insertTask(subjectId, field, targetVersion, intentId, 'CASDOOR_SYNC');
  }

  async scheduleProfileReadback(
    subjectId: string,
    field: EditableProfileField,
    targetVersion: number,
    intentId: string,
  ): Promise<void> {
    await this.insertTask(subjectId, field, targetVersion, intentId, 'CASDOOR_SYNC');
  }

  async scheduleNameCorrectionWrite(
    requestId: string,
    subjectId: string,
    newName: string,
    now: Date,
  ): Promise<void> {
    const taskId = `name-correction:${subjectId}:${requestId}`;
    await this.db.query(
      this.uow.active,
      `INSERT INTO job_tasks
         (task_id, task_type, status, intent_id, idempotency_key, scope, source, payload,
          attempts, max_attempts, not_before)
       VALUES ($1, 'CASDOOR_SYNC', 'PENDING', $1, $1,
               $2::jsonb, $3::jsonb, $4::jsonb, 0, ${MAX_ATTEMPTS}, $5)
       ON CONFLICT (task_id) DO NOTHING`,
      [
        taskId,
        JSON.stringify({ kind: 'single', subjectId }),
        JSON.stringify({ module: 'identity', writer: 'profile-sync-task.writer' }),
        JSON.stringify({ requestId, subjectId, newName }),
        now,
      ],
    );
  }

  private async insertTask(
    subjectId: string,
    field: EditableProfileField,
    targetVersion: number,
    intentId: string,
    taskType: 'CASDOOR_SYNC',
  ): Promise<void> {
    const taskId = `${taskType}:${subjectId}:${field}:${targetVersion}`;
    await this.db.query(
      this.uow.active,
      `INSERT INTO job_tasks
         (task_id, task_type, status, intent_id, idempotency_key, scope, source, payload,
          attempts, max_attempts, not_before)
       VALUES ($1, $2, 'PENDING', $3, $1,
               $4::jsonb, $5::jsonb, $6::jsonb, 0, ${MAX_ATTEMPTS}, now())
       ON CONFLICT (task_id) DO NOTHING`,
      [
        taskId,
        taskType,
        intentId,
        JSON.stringify({ kind: 'single', subjectId }),
        JSON.stringify({ module: 'identity', writer: 'profile-sync-task.writer' }),
        JSON.stringify({ subjectId, field, targetVersion, intentId }),
      ],
    );
  }
}
