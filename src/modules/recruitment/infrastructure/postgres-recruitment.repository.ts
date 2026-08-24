/**
 * PostgreSQL 招新仓储（infrastructure；4.4 REC-001~005 持久化）。
 *
 * 表：recruitment_activities / application_channels / applications /
 * department_paths / interview_records（列与迁移 20260822000000 逐列对齐）。
 * 读路径以 uow.active 事务上下文执行（脱离事务失败关闭）；写以 id 主键
 * upsert（乐观守卫由应用层保证版本/修订号）。JSONB 字段读写兼容 PG（对象）
 * 与内存测试替身（字符串）两种载荷。
 */

import type { DbAdapter } from '../../../shared/db-adapter';
import { RecruitmentDomainError } from '../domain/errors';
import type { RecruitmentUnitOfWork } from './unit-of-work';
import type { RecruitmentRepository } from '../application/ports/recruitment-repository.port';
import type { RecruitmentActivitySnapshot } from '../domain/models/recruitment-activity';
import type { ApplicationChannelSnapshot } from '../domain/models/application-channel';
import type { ApplicationSnapshot } from '../domain/models/application';
import type { DepartmentPathSnapshot } from '../domain/models/department-path';
import type { InterviewRecordSnapshot } from '../domain/models/interview-record';

interface ActivityRow {
  id: string;
  club_id: string;
  title: string;
  description: string | null;
  status: string;
  paused: boolean;
  end_date: Date | null;
  created_by: string;
  created_at: Date;
  updated_at: Date;
}
interface ChannelRow {
  id: string;
  activity_id: string;
  club_id: string;
  status: string;
  open_at: Date | null;
  close_at: Date | null;
  deadline: Date | null;
  min_choices: number;
  max_choices: number;
  created_at: Date;
  updated_at: Date;
}
interface ApplicationRow {
  id: string;
  activity_id: string;
  channel_id: string;
  club_id: string;
  applicant_id: string;
  status: string;
  department_choices: unknown;
  form_ref: unknown;
  qualify_snapshot: unknown;
  revision_number: number;
  revisions: unknown;
  supplement_due_at: Date | null;
  created_at: Date;
  updated_at: Date;
}
interface PathRow {
  id: string;
  application_id: string;
  activity_id: string;
  club_id: string;
  department_id: string;
  status: string;
  revision_number: number;
  allow_transfer: boolean;
  decisions: unknown;
  previous_status_before_suspend: string | null;
  created_at: Date;
  updated_at: Date;
}
interface InterviewRow {
  id: string;
  application_id: string;
  activity_id: string;
  club_id: string;
  round_id: string;
  applicant_id: string;
  status: string;
  revision_number: number;
  interviewer_id: string | null;
  scheduled_at: Date | null;
  location: string | null;
  skip_reason: string | null;
  hold_until: Date | null;
  evaluations: unknown;
  created_at: Date;
  updated_at: Date;
}

function parseJsonb<T>(value: unknown): T {
  if (typeof value === 'string') {
    return JSON.parse(value) as T;
  }
  return value as T;
}

export function activityRowToSnapshot(row: ActivityRow): RecruitmentActivitySnapshot {
  return {
    id: row.id,
    clubId: row.club_id,
    title: row.title,
    description: row.description,
    status: row.status as RecruitmentActivitySnapshot['status'],
    paused: row.paused,
    endDate: row.end_date,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
export function channelRowToSnapshot(row: ChannelRow): ApplicationChannelSnapshot {
  return {
    id: row.id,
    activityId: row.activity_id,
    clubId: row.club_id,
    status: row.status as ApplicationChannelSnapshot['status'],
    openAt: row.open_at,
    closeAt: row.close_at,
    deadline: row.deadline,
    minChoices: row.min_choices,
    maxChoices: row.max_choices,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
export function applicationRowToSnapshot(row: ApplicationRow): ApplicationSnapshot {
  return {
    id: row.id,
    activityId: row.activity_id,
    channelId: row.channel_id,
    clubId: row.club_id,
    applicantId: row.applicant_id,
    status: row.status as ApplicationSnapshot['status'],
    departmentChoices: parseJsonb(row.department_choices),
    formRef: row.form_ref === null ? null : parseJsonb(row.form_ref),
    qualifySnapshot: parseJsonb(row.qualify_snapshot),
    revisions: parseJsonb(row.revisions),
    revisionNumber: Number(row.revision_number),
    supplementDueAt: row.supplement_due_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
export function departmentPathRowToSnapshot(row: PathRow): DepartmentPathSnapshot {
  return {
    id: row.id,
    applicationId: row.application_id,
    activityId: row.activity_id,
    clubId: row.club_id,
    departmentId: row.department_id,
    status: row.status as DepartmentPathSnapshot['status'],
    revisionNumber: Number(row.revision_number),
    allowTransfer: row.allow_transfer,
    decisions: parseJsonb(row.decisions),
    previousStatusBeforeSuspend:
      row.previous_status_before_suspend === null
        ? null
        : (row.previous_status_before_suspend as DepartmentPathSnapshot['previousStatusBeforeSuspend']),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
export function interviewRowToSnapshot(row: InterviewRow): InterviewRecordSnapshot {
  return {
    id: row.id,
    applicationId: row.application_id,
    activityId: row.activity_id,
    clubId: row.club_id,
    roundId: row.round_id,
    applicantId: row.applicant_id,
    status: row.status as InterviewRecordSnapshot['status'],
    revisionNumber: Number(row.revision_number),
    interviewerId: row.interviewer_id,
    scheduledAt: row.scheduled_at,
    location: row.location,
    skipReason: row.skip_reason,
    holdUntil: row.hold_until,
    evaluations: parseJsonb(row.evaluations),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class PostgresRecruitmentRepository implements RecruitmentRepository {
  constructor(
    private readonly db: DbAdapter,
    private readonly uow: RecruitmentUnitOfWork,
  ) {}

  // ----- 活动 -----
  async loadActivity(id: string): Promise<RecruitmentActivitySnapshot | null> {
    const rows = await this.db.query<ActivityRow>(
      this.uow.active,
      `SELECT id, club_id, title, description, status, paused, created_by, created_at, updated_at
         FROM recruitment_activities WHERE id = $1`,
      [id],
    );
    return rows[0] ? activityRowToSnapshot(rows[0]) : null;
  }
  async saveActivity(s: RecruitmentActivitySnapshot): Promise<void> {
    await this.db.query(
      this.uow.active,
      `INSERT INTO recruitment_activities
         (id, club_id, title, description, status, paused, end_date, created_by, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (id) DO UPDATE SET
         club_id = EXCLUDED.club_id, title = EXCLUDED.title, description = EXCLUDED.description,
         status = EXCLUDED.status, paused = EXCLUDED.paused, end_date = EXCLUDED.end_date,
         updated_at = EXCLUDED.updated_at`,
      [
        s.id,
        s.clubId,
        s.title,
        s.description,
        s.status,
        s.paused,
        s.endDate,
        s.createdBy,
        s.createdAt,
        s.updatedAt,
      ],
    );
  }
  async loadActivitiesByClub(clubId: string): Promise<RecruitmentActivitySnapshot[]> {
    const rows = await this.db.query<ActivityRow>(
      this.uow.active,
      `SELECT id, club_id, title, description, status, paused, created_by, created_at, updated_at
         FROM recruitment_activities WHERE club_id = $1 ORDER BY updated_at DESC`,
      [clubId],
    );
    return rows.map(activityRowToSnapshot);
  }

  // ----- 通道 -----
  async loadChannel(id: string): Promise<ApplicationChannelSnapshot | null> {
    const rows = await this.db.query<ChannelRow>(
      this.uow.active,
      `SELECT id, activity_id, club_id, status, open_at, close_at, deadline, min_choices, max_choices, created_at, updated_at
          FROM application_channels WHERE id = $1`,
      [id],
    );
    return rows[0] ? channelRowToSnapshot(rows[0]) : null;
  }
  async saveChannel(s: ApplicationChannelSnapshot): Promise<void> {
    await this.db.query(
      this.uow.active,
      `INSERT INTO application_channels
          (id, activity_id, club_id, status, open_at, close_at, deadline, min_choices, max_choices, created_at, updated_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
        ON CONFLICT (id) DO UPDATE SET
          activity_id = EXCLUDED.activity_id, club_id = EXCLUDED.club_id, status = EXCLUDED.status,
          open_at = EXCLUDED.open_at, close_at = EXCLUDED.close_at, deadline = EXCLUDED.deadline, min_choices = EXCLUDED.min_choices,
          max_choices = EXCLUDED.max_choices, updated_at = EXCLUDED.updated_at`,
      [
        s.id,
        s.activityId,
        s.clubId,
        s.status,
        s.openAt,
        s.closeAt,
        s.deadline,
        s.minChoices,
        s.maxChoices,
        s.createdAt,
        s.updatedAt,
      ],
    );
  }

  // ----- 申请 -----
  async loadApplication(id: string): Promise<ApplicationSnapshot | null> {
    const rows = await this.db.query<ApplicationRow>(
      this.uow.active,
      `SELECT id, activity_id, channel_id, club_id, applicant_id, status, department_choices,
              form_ref, qualify_snapshot, revision_number, revisions, supplement_due_at,
              created_at, updated_at
         FROM applications WHERE id = $1`,
      [id],
    );
    return rows[0] ? applicationRowToSnapshot(rows[0]) : null;
  }
  async saveApplication(s: ApplicationSnapshot, expectedRevision: number): Promise<void> {
    if (expectedRevision === -1) {
      const inserted = await this.db.query<{ id: string }>(
        this.uow.active,
        `INSERT INTO applications
          (id, activity_id, channel_id, club_id, applicant_id, status, department_choices,
           form_ref, qualify_snapshot, revision_number, revisions, supplement_due_at, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
         ON CONFLICT DO NOTHING RETURNING id`,
        [
          s.id,
          s.activityId,
          s.channelId,
          s.clubId,
          s.applicantId,
          s.status,
          JSON.stringify(s.departmentChoices),
          s.formRef === null ? null : JSON.stringify(s.formRef),
          JSON.stringify(s.qualifySnapshot),
          s.revisionNumber,
          JSON.stringify(s.revisions),
          s.supplementDueAt,
          s.createdAt,
          s.updatedAt,
        ],
      );
      if (inserted.length === 0) {
        throw new RecruitmentDomainError('REC_CONFLICT', '申请并发冲突，请刷新后重试');
      }
      return;
    }
    const updated = await this.db.query<{ id: string }>(
      this.uow.active,
      `UPDATE applications SET
        activity_id = $2, channel_id = $3, club_id = $4, applicant_id = $5, status = $6,
        department_choices = $7, form_ref = $8, qualify_snapshot = $9, revision_number = $10,
        revisions = $11, supplement_due_at = $12, updated_at = $13
      WHERE id = $1 AND revision_number = $14
      RETURNING id`,
      [
        s.id,
        s.activityId,
        s.channelId,
        s.clubId,
        s.applicantId,
        s.status,
        JSON.stringify(s.departmentChoices),
        s.formRef === null ? null : JSON.stringify(s.formRef),
        JSON.stringify(s.qualifySnapshot),
        s.revisionNumber,
        JSON.stringify(s.revisions),
        s.supplementDueAt,
        s.updatedAt,
        expectedRevision,
      ],
    );
    if (updated.length === 0) {
      throw new RecruitmentDomainError(
        'REC_CONFLICT',
        '申请并发冲突（修订号守卫未命中），请刷新后重试',
      );
    }
  }
  async loadApplicationByApplicantAndChannel(
    applicantId: string,
    channelId: string,
  ): Promise<ApplicationSnapshot | null> {
    const rows = await this.db.query<ApplicationRow>(
      this.uow.active,
      `SELECT id, activity_id, channel_id, club_id, applicant_id, status, department_choices,
              form_ref, qualify_snapshot, revision_number, revisions, supplement_due_at,
              created_at, updated_at
         FROM applications WHERE applicant_id = $1 AND channel_id = $2`,
      [applicantId, channelId],
    );
    return rows[0] ? applicationRowToSnapshot(rows[0]) : null;
  }
  async loadApplicationsByActivity(activityId: string): Promise<ApplicationSnapshot[]> {
    const rows = await this.db.query<ApplicationRow>(
      this.uow.active,
      `SELECT id, activity_id, channel_id, club_id, applicant_id, status, department_choices,
              form_ref, qualify_snapshot, revision_number, revisions, supplement_due_at,
              created_at, updated_at
         FROM applications WHERE activity_id = $1 ORDER BY updated_at DESC`,
      [activityId],
    );
    return rows.map(applicationRowToSnapshot);
  }

  // ----- 部门路径 -----
  async loadDepartmentPath(id: string): Promise<DepartmentPathSnapshot | null> {
    const rows = await this.db.query<PathRow>(
      this.uow.active,
      `SELECT id, application_id, activity_id, club_id, department_id, status, revision_number, allow_transfer,
               decisions, previous_status_before_suspend, created_at, updated_at
          FROM department_paths WHERE id = $1`,
      [id],
    );
    return rows[0] ? departmentPathRowToSnapshot(rows[0]) : null;
  }
  async saveDepartmentPath(s: DepartmentPathSnapshot, expectedRevision: number): Promise<void> {
    if (expectedRevision === -1) {
      const inserted = await this.db.query<{ id: string }>(
        this.uow.active,
        `INSERT INTO department_paths
          (id, application_id, activity_id, club_id, department_id, status, revision_number,
           allow_transfer, decisions, previous_status_before_suspend, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         ON CONFLICT DO NOTHING RETURNING id`,
        [
          s.id,
          s.applicationId,
          s.activityId,
          s.clubId,
          s.departmentId,
          s.status,
          s.revisionNumber,
          s.allowTransfer,
          JSON.stringify(s.decisions),
          s.previousStatusBeforeSuspend,
          s.createdAt,
          s.updatedAt,
        ],
      );
      if (inserted.length === 0) {
        throw new RecruitmentDomainError('REC_CONFLICT', '部门路径并发冲突，请刷新后重试');
      }
      return;
    }
    const updated = await this.db.query<{ id: string }>(
      this.uow.active,
      `UPDATE department_paths SET
        application_id = $2, activity_id = $3, club_id = $4, department_id = $5, status = $6,
        allow_transfer = $7, decisions = $8, previous_status_before_suspend = $9,
        revision_number = $10, updated_at = $11
      WHERE id = $1 AND revision_number = $12
      RETURNING id`,
      [
        s.id,
        s.applicationId,
        s.activityId,
        s.clubId,
        s.departmentId,
        s.status,
        s.allowTransfer,
        JSON.stringify(s.decisions),
        s.previousStatusBeforeSuspend,
        s.revisionNumber,
        s.updatedAt,
        expectedRevision,
      ],
    );
    if (updated.length === 0) {
      throw new RecruitmentDomainError(
        'REC_CONFLICT',
        '部门路径并发冲突（修订号守卫未命中），请刷新后重试',
      );
    }
  }
  async loadDepartmentPathsByApplication(applicationId: string): Promise<DepartmentPathSnapshot[]> {
    const rows = await this.db.query<PathRow>(
      this.uow.active,
      `SELECT id, application_id, activity_id, club_id, department_id, status, revision_number, allow_transfer,
               decisions, previous_status_before_suspend, created_at, updated_at
          FROM department_paths WHERE application_id = $1 ORDER BY updated_at DESC`,
      [applicationId],
    );
    return rows.map(departmentPathRowToSnapshot);
  }

  // ----- 面试记录 -----
  async loadInterview(id: string): Promise<InterviewRecordSnapshot | null> {
    const rows = await this.db.query<InterviewRow>(
      this.uow.active,
      `SELECT id, application_id, activity_id, club_id, round_id, applicant_id, status, revision_number,
               interviewer_id, scheduled_at, location, skip_reason, hold_until, evaluations,
               created_at, updated_at
          FROM interview_records WHERE id = $1`,
      [id],
    );
    return rows[0] ? interviewRowToSnapshot(rows[0]) : null;
  }
  async saveInterview(s: InterviewRecordSnapshot, expectedRevision: number): Promise<void> {
    if (expectedRevision === -1) {
      const inserted = await this.db.query<{ id: string }>(
        this.uow.active,
        `INSERT INTO interview_records
          (id, application_id, activity_id, club_id, round_id, applicant_id, status, revision_number,
           interviewer_id, scheduled_at, location, skip_reason, hold_until, evaluations,
           created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
         ON CONFLICT DO NOTHING RETURNING id`,
        [
          s.id,
          s.applicationId,
          s.activityId,
          s.clubId,
          s.roundId,
          s.applicantId,
          s.status,
          s.revisionNumber,
          s.interviewerId,
          s.scheduledAt,
          s.location,
          s.skipReason,
          s.holdUntil,
          JSON.stringify(s.evaluations),
          s.createdAt,
          s.updatedAt,
        ],
      );
      if (inserted.length === 0) {
        throw new RecruitmentDomainError('REC_CONFLICT', '面试记录并发冲突，请刷新后重试');
      }
      return;
    }
    const updated = await this.db.query<{ id: string }>(
      this.uow.active,
      `UPDATE interview_records SET
        application_id = $2, activity_id = $3, club_id = $4, round_id = $5, applicant_id = $6,
        status = $7, interviewer_id = $8, scheduled_at = $9, location = $10, skip_reason = $11,
        hold_until = $12, evaluations = $13, revision_number = $14, updated_at = $15
      WHERE id = $1 AND revision_number = $16
      RETURNING id`,
      [
        s.id,
        s.applicationId,
        s.activityId,
        s.clubId,
        s.roundId,
        s.applicantId,
        s.status,
        s.interviewerId,
        s.scheduledAt,
        s.location,
        s.skipReason,
        s.holdUntil,
        JSON.stringify(s.evaluations),
        s.revisionNumber,
        s.updatedAt,
        expectedRevision,
      ],
    );
    if (updated.length === 0) {
      throw new RecruitmentDomainError(
        'REC_CONFLICT',
        '面试记录并发冲突（修订号守卫未命中），请刷新后重试',
      );
    }
  }
  async loadInterviewsByRound(roundId: string): Promise<InterviewRecordSnapshot[]> {
    const rows = await this.db.query<InterviewRow>(
      this.uow.active,
      `SELECT id, application_id, activity_id, club_id, round_id, applicant_id, status, revision_number,
               interviewer_id, scheduled_at, location, skip_reason, hold_until, evaluations,
               created_at, updated_at
          FROM interview_records WHERE round_id = $1 ORDER BY updated_at DESC`,
      [roundId],
    );
    return rows.map(interviewRowToSnapshot);
  }
}
