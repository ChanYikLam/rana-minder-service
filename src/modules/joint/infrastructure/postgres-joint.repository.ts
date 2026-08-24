/**
 * PostgreSQL 联合仓储（infrastructure；5.1 JNT-001~006 持久化）。
 *
 * 表：joint_activities / joint_participants / joint_applications / joint_interviews /
 * joint_conclusions / joint_channels（列与迁移 20260823120000 逐列对齐）。
 * 读路径以 uow.active 事务上下文执行（脱离事务失败关闭）；写以 id 主键
 * upsert（乐观守卫由应用层保证版本/修订号）。JSONB 字段读写兼容 PG（对象）
 * 与内存测试替身（字符串）两种载荷。
 */

import type { DbAdapter } from '../../../shared/db-adapter';
import type { JointUnitOfWork } from './unit-of-work';
import { JointConflictError } from '../application/ports/joint-repository.port';
import type { JointRepository } from '../application/ports/joint-repository.port';
import type { JointActivitySnapshot } from '../domain/models/joint-activity';
import type { JointParticipantSnapshot } from '../domain/models/joint-participant';
import type { JointApplicationSnapshot } from '../domain/models/joint-application';
import type { JointInterviewSnapshot } from '../domain/models/joint-interview';
import type { JointConclusionSnapshot } from '../domain/models/joint-conclusion';
import type { JointChannelSnapshot } from '../domain/models/joint-channel';

interface ActivityRow {
  id: string;
  title: string;
  description: string | null;
  status: string;
  confirm_round: number;
  confirm_deadline: Date | null;
  published_at: Date | null;
  first_invitation_at: Date | null;
  cancel_round: number;
  forced_ended_reason: string | null;
  revision_number: number;
  created_by: string;
  created_at: Date;
  updated_at: Date;
}
interface ParticipantRow {
  id: string;
  activity_id: string;
  club_id: string;
  round_id: number;
  status: string;
  decided_by: string | null;
  confirmed_at: Date | null;
  suspended_at: Date | null;
  resumed_at: Date | null;
  suspended_for_ms: number;
  revision_number: number;
  created_at: Date;
  updated_at: Date;
}
interface ApplicationRow {
  id: string;
  joint_activity_id: string;
  applicant_id: string;
  status: string;
  form_ref: unknown;
  participants_snapshot: unknown;
  consent_snapshot_hash: string | null;
  shared_note: string | null;
  revision_number: number;
  created_at: Date;
  updated_at: Date;
}
interface InterviewRow {
  id: string;
  joint_activity_id: string;
  joint_application_id: string;
  status: string;
  scheduled_at: Date | null;
  location: string | null;
  method: string | null;
  evaluations: unknown;
  voided_reason: string | null;
  revision_number: number;
  created_at: Date;
  updated_at: Date;
}
interface ConclusionRow {
  id: string;
  joint_activity_id: string;
  joint_application_id: string;
  club_id: string;
  status: string;
  decision: string | null;
  note: string | null;
  version: number;
  decided_by: string | null;
  decided_at: Date | null;
  invite_status: string;
  invitation_id: string | null;
  versions: unknown;
  revision_number: number;
  created_at: Date;
  updated_at: Date;
}
interface ChannelRow {
  id: string;
  joint_activity_id: string;
  status: string;
  current_window: unknown;
  windows: unknown;
  revision_number: number;
  created_at: Date;
  updated_at: Date;
}

function parseJsonb<T>(value: unknown): T {
  if (typeof value === 'string') {
    return JSON.parse(value) as T;
  }
  return value as T;
}

export function activityRowToSnapshot(row: ActivityRow): JointActivitySnapshot {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    status: row.status as JointActivitySnapshot['status'],
    confirmRound: Number(row.confirm_round),
    confirmDeadline: row.confirm_deadline,
    publishedAt: row.published_at,
    firstInvitationAt: row.first_invitation_at,
    cancelRound: Number(row.cancel_round),
    forcedEndedReason: row.forced_ended_reason,
    revisionNumber: Number(row.revision_number),
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
export function participantRowToSnapshot(row: ParticipantRow): JointParticipantSnapshot {
  return {
    id: row.id,
    activityId: row.activity_id,
    clubId: row.club_id,
    roundId: Number(row.round_id),
    status: row.status as JointParticipantSnapshot['status'],
    decidedBy: row.decided_by,
    confirmedAt: row.confirmed_at,
    suspendedAt: row.suspended_at,
    resumedAt: row.resumed_at,
    suspendedForMs: Number(row.suspended_for_ms),
    revisionNumber: Number(row.revision_number),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
export function applicationRowToSnapshot(row: ApplicationRow): JointApplicationSnapshot {
  return {
    id: row.id,
    jointActivityId: row.joint_activity_id,
    applicantId: row.applicant_id,
    status: row.status as JointApplicationSnapshot['status'],
    formRef: row.form_ref === null ? null : parseJsonb(row.form_ref),
    participantsSnapshot: parseJsonb(row.participants_snapshot),
    consentSnapshotHash: row.consent_snapshot_hash,
    sharedNote: row.shared_note,
    revisionNumber: Number(row.revision_number),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
export function interviewRowToSnapshot(row: InterviewRow): JointInterviewSnapshot {
  return {
    id: row.id,
    jointActivityId: row.joint_activity_id,
    jointApplicationId: row.joint_application_id,
    status: row.status as JointInterviewSnapshot['status'],
    scheduledAt: row.scheduled_at,
    location: row.location,
    method: row.method,
    evaluations: parseJsonb(row.evaluations),
    voidedReason: row.voided_reason,
    revisionNumber: Number(row.revision_number),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
export function conclusionRowToSnapshot(row: ConclusionRow): JointConclusionSnapshot {
  return {
    id: row.id,
    jointActivityId: row.joint_activity_id,
    jointApplicationId: row.joint_application_id,
    clubId: row.club_id,
    status: row.status as JointConclusionSnapshot['status'],
    decision: row.decision as JointConclusionSnapshot['decision'],
    note: row.note,
    version: Number(row.version),
    decidedBy: row.decided_by,
    decidedAt: row.decided_at,
    inviteStatus: row.invite_status as JointConclusionSnapshot['inviteStatus'],
    invitationId: row.invitation_id,
    versions: parseJsonb(row.versions),
    revisionNumber: Number(row.revision_number),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
export function channelRowToSnapshot(row: ChannelRow): JointChannelSnapshot {
  return {
    id: row.id,
    jointActivityId: row.joint_activity_id,
    status: row.status as JointChannelSnapshot['status'],
    currentWindow: row.current_window === null ? null : parseJsonb(row.current_window),
    windows: parseJsonb(row.windows),
    revisionNumber: Number(row.revision_number),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class PostgresJointRepository implements JointRepository {
  constructor(
    private readonly db: DbAdapter,
    private readonly uow: JointUnitOfWork,
  ) {}

  // ----- 联合活动 -----
  async loadActivity(id: string): Promise<JointActivitySnapshot | null> {
    const rows = await this.db.query<ActivityRow>(
      this.uow.active,
      `SELECT id, title, description, status, confirm_round, confirm_deadline, published_at,
              first_invitation_at, cancel_round, forced_ended_reason, revision_number,
              created_by, created_at, updated_at
         FROM joint_activities WHERE id = $1`,
      [id],
    );
    return rows[0] ? activityRowToSnapshot(rows[0]) : null;
  }
  async saveActivity(s: JointActivitySnapshot, expectedRevision: number): Promise<void> {
    if (expectedRevision === -1) {
      const inserted = await this.db.query<{ id: string }>(
        this.uow.active,
        `INSERT INTO joint_activities
           (id, title, description, status, confirm_round, confirm_deadline, published_at,
            first_invitation_at, cancel_round, forced_ended_reason, revision_number,
            created_by, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
         ON CONFLICT (id) DO NOTHING RETURNING id`,
        [
          s.id,
          s.title,
          s.description,
          s.status,
          s.confirmRound,
          s.confirmDeadline,
          s.publishedAt,
          s.firstInvitationAt,
          s.cancelRound,
          s.forcedEndedReason,
          s.revisionNumber,
          s.createdBy,
          s.createdAt,
          s.updatedAt,
        ],
      );
      if (inserted.length === 0) {
        throw new JointConflictError('联合聚合并发冲突，请刷新后重试');
      }
      return;
    }
    const updated = await this.db.query<{ id: string }>(
      this.uow.active,
      `UPDATE joint_activities SET
         title = $2, description = $3, status = $4, confirm_round = $5, confirm_deadline = $6,
         published_at = $7, first_invitation_at = $8, cancel_round = $9, forced_ended_reason = $10,
         revision_number = $11, created_by = $12, updated_at = $13
       WHERE id = $1 AND revision_number = $14
       RETURNING id`,
      [
        s.id,
        s.title,
        s.description,
        s.status,
        s.confirmRound,
        s.confirmDeadline,
        s.publishedAt,
        s.firstInvitationAt,
        s.cancelRound,
        s.forcedEndedReason,
        s.revisionNumber,
        s.createdBy,
        s.updatedAt,
        expectedRevision,
      ],
    );
    if (updated.length === 0) {
      throw new JointConflictError('联合聚合并发冲突，请刷新后重试');
    }
  }

  // ----- 参与社团关系 -----
  async loadParticipant(id: string): Promise<JointParticipantSnapshot | null> {
    const rows = await this.db.query<ParticipantRow>(
      this.uow.active,
      `SELECT id, activity_id, club_id, round_id, status, decided_by, confirmed_at,
              suspended_at, resumed_at, suspended_for_ms, revision_number, created_at, updated_at
         FROM joint_participants WHERE id = $1`,
      [id],
    );
    return rows[0] ? participantRowToSnapshot(rows[0]) : null;
  }
  async loadParticipantsByActivity(activityId: string): Promise<JointParticipantSnapshot[]> {
    const rows = await this.db.query<ParticipantRow>(
      this.uow.active,
      `SELECT id, activity_id, club_id, round_id, status, decided_by, confirmed_at,
              suspended_at, resumed_at, suspended_for_ms, revision_number, created_at, updated_at
         FROM joint_participants WHERE activity_id = $1 ORDER BY updated_at DESC`,
      [activityId],
    );
    return rows.map(participantRowToSnapshot);
  }
  async saveParticipant(s: JointParticipantSnapshot, expectedRevision: number): Promise<void> {
    if (expectedRevision === -1) {
      const inserted = await this.db.query<{ id: string }>(
        this.uow.active,
        `INSERT INTO joint_participants
           (id, activity_id, club_id, round_id, status, decided_by, confirmed_at,
            suspended_at, resumed_at, suspended_for_ms, revision_number, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
         ON CONFLICT (activity_id, club_id, round_id) DO NOTHING RETURNING id`,
        [
          s.id,
          s.activityId,
          s.clubId,
          s.roundId,
          s.status,
          s.decidedBy,
          s.confirmedAt,
          s.suspendedAt,
          s.resumedAt,
          s.suspendedForMs,
          s.revisionNumber,
          s.createdAt,
          s.updatedAt,
        ],
      );
      if (inserted.length === 0) {
        throw new JointConflictError('联合聚合并发冲突，请刷新后重试');
      }
      return;
    }
    const updated = await this.db.query<{ id: string }>(
      this.uow.active,
      `UPDATE joint_participants SET
         activity_id = $2, club_id = $3, round_id = $4, status = $5, decided_by = $6,
         confirmed_at = $7, suspended_at = $8, resumed_at = $9, suspended_for_ms = $10,
         revision_number = $11, updated_at = $12
       WHERE id = $1 AND revision_number = $13
       RETURNING id`,
      [
        s.id,
        s.activityId,
        s.clubId,
        s.roundId,
        s.status,
        s.decidedBy,
        s.confirmedAt,
        s.suspendedAt,
        s.resumedAt,
        s.suspendedForMs,
        s.revisionNumber,
        s.updatedAt,
        expectedRevision,
      ],
    );
    if (updated.length === 0) {
      throw new JointConflictError('联合聚合并发冲突，请刷新后重试');
    }
  }

  // ----- 联合申请 -----
  async loadApplication(id: string): Promise<JointApplicationSnapshot | null> {
    const rows = await this.db.query<ApplicationRow>(
      this.uow.active,
      `SELECT id, joint_activity_id, applicant_id, status, form_ref, participants_snapshot,
              consent_snapshot_hash, shared_note, revision_number, created_at, updated_at
         FROM joint_applications WHERE id = $1`,
      [id],
    );
    return rows[0] ? applicationRowToSnapshot(rows[0]) : null;
  }
  async loadApplicationsByActivity(activityId: string): Promise<JointApplicationSnapshot[]> {
    const rows = await this.db.query<ApplicationRow>(
      this.uow.active,
      `SELECT id, joint_activity_id, applicant_id, status, form_ref, participants_snapshot,
              consent_snapshot_hash, shared_note, revision_number, created_at, updated_at
         FROM joint_applications WHERE joint_activity_id = $1 ORDER BY updated_at DESC`,
      [activityId],
    );
    return rows.map(applicationRowToSnapshot);
  }
  async saveApplication(s: JointApplicationSnapshot, expectedRevision: number): Promise<void> {
    if (expectedRevision === -1) {
      const inserted = await this.db.query<{ id: string }>(
        this.uow.active,
        `INSERT INTO joint_applications
           (id, joint_activity_id, applicant_id, status, form_ref, participants_snapshot,
            consent_snapshot_hash, shared_note, revision_number, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         ON CONFLICT (joint_activity_id, applicant_id) DO NOTHING RETURNING id`,
        [
          s.id,
          s.jointActivityId,
          s.applicantId,
          s.status,
          s.formRef === null ? null : JSON.stringify(s.formRef),
          JSON.stringify(s.participantsSnapshot),
          s.consentSnapshotHash,
          s.sharedNote,
          s.revisionNumber,
          s.createdAt,
          s.updatedAt,
        ],
      );
      if (inserted.length === 0) {
        throw new JointConflictError('联合聚合并发冲突，请刷新后重试');
      }
      return;
    }
    const updated = await this.db.query<{ id: string }>(
      this.uow.active,
      `UPDATE joint_applications SET
         joint_activity_id = $2, applicant_id = $3, status = $4, form_ref = $5,
         participants_snapshot = $6, consent_snapshot_hash = $7, shared_note = $8,
         revision_number = $9, updated_at = $10
       WHERE id = $1 AND revision_number = $11
       RETURNING id`,
      [
        s.id,
        s.jointActivityId,
        s.applicantId,
        s.status,
        s.formRef === null ? null : JSON.stringify(s.formRef),
        JSON.stringify(s.participantsSnapshot),
        s.consentSnapshotHash,
        s.sharedNote,
        s.revisionNumber,
        s.updatedAt,
        expectedRevision,
      ],
    );
    if (updated.length === 0) {
      throw new JointConflictError('联合聚合并发冲突，请刷新后重试');
    }
  }

  // ----- 联合面试 -----
  async loadInterview(id: string): Promise<JointInterviewSnapshot | null> {
    const rows = await this.db.query<InterviewRow>(
      this.uow.active,
      `SELECT id, joint_activity_id, joint_application_id, status, scheduled_at, location,
              method, evaluations, voided_reason, revision_number, created_at, updated_at
         FROM joint_interviews WHERE id = $1`,
      [id],
    );
    return rows[0] ? interviewRowToSnapshot(rows[0]) : null;
  }
  async loadInterviewByApplication(applicationId: string): Promise<JointInterviewSnapshot | null> {
    const rows = await this.db.query<InterviewRow>(
      this.uow.active,
      `SELECT id, joint_activity_id, joint_application_id, status, scheduled_at, location,
              method, evaluations, voided_reason, revision_number, created_at, updated_at
         FROM joint_interviews WHERE joint_application_id = $1`,
      [applicationId],
    );
    return rows[0] ? interviewRowToSnapshot(rows[0]) : null;
  }
  async loadInterviewsByActivity(activityId: string): Promise<JointInterviewSnapshot[]> {
    const rows = await this.db.query<InterviewRow>(
      this.uow.active,
      `SELECT id, joint_activity_id, joint_application_id, status, scheduled_at, location,
              method, evaluations, voided_reason, revision_number, created_at, updated_at
         FROM joint_interviews WHERE joint_activity_id = $1 ORDER BY updated_at DESC`,
      [activityId],
    );
    return rows.map(interviewRowToSnapshot);
  }
  async saveInterview(s: JointInterviewSnapshot, expectedRevision: number): Promise<void> {
    if (expectedRevision === -1) {
      const inserted = await this.db.query<{ id: string }>(
        this.uow.active,
        `INSERT INTO joint_interviews
           (id, joint_activity_id, joint_application_id, status, scheduled_at, location,
            method, evaluations, voided_reason, revision_number, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         ON CONFLICT (joint_application_id) DO NOTHING RETURNING id`,
        [
          s.id,
          s.jointActivityId,
          s.jointApplicationId,
          s.status,
          s.scheduledAt,
          s.location,
          s.method,
          JSON.stringify(s.evaluations),
          s.voidedReason,
          s.revisionNumber,
          s.createdAt,
          s.updatedAt,
        ],
      );
      if (inserted.length === 0) {
        throw new JointConflictError('联合聚合并发冲突，请刷新后重试');
      }
      return;
    }
    const updated = await this.db.query<{ id: string }>(
      this.uow.active,
      `UPDATE joint_interviews SET
         joint_activity_id = $2, joint_application_id = $3, status = $4, scheduled_at = $5,
         location = $6, method = $7, evaluations = $8, voided_reason = $9,
         revision_number = $10, updated_at = $11
       WHERE id = $1 AND revision_number = $12
       RETURNING id`,
      [
        s.id,
        s.jointActivityId,
        s.jointApplicationId,
        s.status,
        s.scheduledAt,
        s.location,
        s.method,
        JSON.stringify(s.evaluations),
        s.voidedReason,
        s.revisionNumber,
        s.updatedAt,
        expectedRevision,
      ],
    );
    if (updated.length === 0) {
      throw new JointConflictError('联合聚合并发冲突，请刷新后重试');
    }
  }

  // ----- 参与社团结论 -----
  async loadConclusion(id: string): Promise<JointConclusionSnapshot | null> {
    const rows = await this.db.query<ConclusionRow>(
      this.uow.active,
      `SELECT id, joint_activity_id, joint_application_id, club_id, status, decision, note,
              version, decided_by, decided_at, invite_status, invitation_id, versions,
              revision_number, created_at, updated_at
         FROM joint_conclusions WHERE id = $1`,
      [id],
    );
    return rows[0] ? conclusionRowToSnapshot(rows[0]) : null;
  }
  async loadConclusionsByApplication(applicationId: string): Promise<JointConclusionSnapshot[]> {
    const rows = await this.db.query<ConclusionRow>(
      this.uow.active,
      `SELECT id, joint_activity_id, joint_application_id, club_id, status, decision, note,
              version, decided_by, decided_at, invite_status, invitation_id, versions,
              revision_number, created_at, updated_at
         FROM joint_conclusions WHERE joint_application_id = $1 ORDER BY updated_at DESC`,
      [applicationId],
    );
    return rows.map(conclusionRowToSnapshot);
  }
  async loadConclusionsByActivity(activityId: string): Promise<JointConclusionSnapshot[]> {
    const rows = await this.db.query<ConclusionRow>(
      this.uow.active,
      `SELECT id, joint_activity_id, joint_application_id, club_id, status, decision, note,
              version, decided_by, decided_at, invite_status, invitation_id, versions,
              revision_number, created_at, updated_at
         FROM joint_conclusions WHERE joint_activity_id = $1 ORDER BY updated_at DESC`,
      [activityId],
    );
    return rows.map(conclusionRowToSnapshot);
  }
  async saveConclusion(s: JointConclusionSnapshot, expectedRevision: number): Promise<void> {
    if (expectedRevision === -1) {
      const inserted = await this.db.query<{ id: string }>(
        this.uow.active,
        `INSERT INTO joint_conclusions
           (id, joint_activity_id, joint_application_id, club_id, status, decision, note,
            version, decided_by, decided_at, invite_status, invitation_id, versions,
            revision_number, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
         ON CONFLICT (joint_application_id, club_id) DO NOTHING RETURNING id`,
        [
          s.id,
          s.jointActivityId,
          s.jointApplicationId,
          s.clubId,
          s.status,
          s.decision,
          s.note,
          s.version,
          s.decidedBy,
          s.decidedAt,
          s.inviteStatus,
          s.invitationId,
          JSON.stringify(s.versions),
          s.revisionNumber,
          s.createdAt,
          s.updatedAt,
        ],
      );
      if (inserted.length === 0) {
        throw new JointConflictError('联合聚合并发冲突，请刷新后重试');
      }
      return;
    }
    const updated = await this.db.query<{ id: string }>(
      this.uow.active,
      `UPDATE joint_conclusions SET
         joint_activity_id = $2, joint_application_id = $3, club_id = $4, status = $5,
         decision = $6, note = $7, version = $8, decided_by = $9, decided_at = $10,
         invite_status = $11, invitation_id = $12, versions = $13, revision_number = $14,
         updated_at = $15
       WHERE id = $1 AND revision_number = $16
       RETURNING id`,
      [
        s.id,
        s.jointActivityId,
        s.jointApplicationId,
        s.clubId,
        s.status,
        s.decision,
        s.note,
        s.version,
        s.decidedBy,
        s.decidedAt,
        s.inviteStatus,
        s.invitationId,
        JSON.stringify(s.versions),
        s.revisionNumber,
        s.updatedAt,
        expectedRevision,
      ],
    );
    if (updated.length === 0) {
      throw new JointConflictError('联合聚合并发冲突，请刷新后重试');
    }
  }

  // ----- 联合报名通道 -----
  async loadChannel(id: string): Promise<JointChannelSnapshot | null> {
    const rows = await this.db.query<ChannelRow>(
      this.uow.active,
      `SELECT id, joint_activity_id, status, current_window, windows, revision_number,
              created_at, updated_at
         FROM joint_channels WHERE id = $1`,
      [id],
    );
    return rows[0] ? channelRowToSnapshot(rows[0]) : null;
  }
  async saveChannel(s: JointChannelSnapshot, expectedRevision: number): Promise<void> {
    if (expectedRevision === -1) {
      const inserted = await this.db.query<{ id: string }>(
        this.uow.active,
        `INSERT INTO joint_channels
           (id, joint_activity_id, status, current_window, windows, revision_number,
            created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (joint_activity_id) DO NOTHING RETURNING id`,
        [
          s.id,
          s.jointActivityId,
          s.status,
          s.currentWindow === null ? null : JSON.stringify(s.currentWindow),
          JSON.stringify(s.windows),
          s.revisionNumber,
          s.createdAt,
          s.updatedAt,
        ],
      );
      if (inserted.length === 0) {
        throw new JointConflictError('联合聚合并发冲突，请刷新后重试');
      }
      return;
    }
    const updated = await this.db.query<{ id: string }>(
      this.uow.active,
      `UPDATE joint_channels SET
         joint_activity_id = $2, status = $3, current_window = $4, windows = $5,
         revision_number = $6, updated_at = $7
       WHERE id = $1 AND revision_number = $8
       RETURNING id`,
      [
        s.id,
        s.jointActivityId,
        s.status,
        s.currentWindow === null ? null : JSON.stringify(s.currentWindow),
        JSON.stringify(s.windows),
        s.revisionNumber,
        s.updatedAt,
        expectedRevision,
      ],
    );
    if (updated.length === 0) {
      throw new JointConflictError('联合聚合并发冲突，请刷新后重试');
    }
  }
}
