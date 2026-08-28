/**
 * 招新公开报名读模型（infrastructure；联调 2026-08-27 新增）。
 *
 * 职责：申请人端公开只读视图与本人申请查询——
 * - 活动公开详情（含社团名、部门、表单 id、截止）
 * - 已发布表单版本（DynamicForm 渲染契约）
 * - 活动当前 OPEN 通道
 * - 本人申请读取（GET /apply 回显）
 *
 * 边界：全部为只读 SQL（连接池直查，不建事务）；写路径（提交申请）走
 * RECRUITMENT_CONTROLLER.submitApplication 的领域用例与工作单元。
 * 上游客收后可并入 PostgresRecruitmentRepository 正式仓储。
 */

import type { Pool } from 'pg';

export interface PublicActivityView {
  readonly id: string;
  readonly clubId: string;
  readonly clubName: string | null;
  readonly title: string;
  readonly description: string | null;
  readonly status: string;
  readonly deadline: string | null;
  readonly departments: Array<{ id: string; name: string }>;
  readonly formId: string | null;
  readonly allowAdjustmentDefault: boolean;
}

export interface PublicFormVersionsView {
  readonly formId: string;
  readonly versions: Array<{ versionNumber: number; fields: unknown[] }>;
}

export interface OpenChannelView {
  readonly id: string;
  readonly minChoices: number;
  readonly maxChoices: number;
  readonly deadline: string | null;
}

export interface ApplicationRow {
  readonly id: string;
  readonly activityId: string;
  readonly channelId: string;
  readonly status: string;
  readonly departmentChoices: unknown[];
  readonly formRef: Record<string, unknown> | null;
  readonly qualifySnapshot: Record<string, unknown> | null;
  readonly revisionNumber: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface ActivityRow {
  id: string;
  club_id: string;
  title: string;
  description: string | null;
  status: string;
  departments: unknown;
  allow_adjustment_default: boolean;
  form_id: string | null;
  deadline: string | null;
  club_payload_name: string | null;
}

export class PublicRecruitmentReadModel {
  constructor(private readonly pool: Pool) {}

  async getActivityPublic(activityId: string): Promise<PublicActivityView | null> {
    const { rows } = await this.pool.query<ActivityRow>(
      `SELECT a.id,
              a.club_id,
              a.title,
              a.description,
              a.status,
              a.departments,
              a.allow_adjustment_default,
              a.form_id,
              ch.deadline::text AS deadline,
              cs.payload ->> 'name' AS club_payload_name
         FROM public.recruitment_activities a
         LEFT JOIN LATERAL (
           SELECT c.deadline
             FROM public.application_channels c
            WHERE c.activity_id = a.id
            ORDER BY (c.status = 'OPEN') DESC, c.updated_at DESC
            LIMIT 1
         ) ch ON true
         LEFT JOIN public.org_club_space cs ON cs.id = a.club_id
        WHERE a.id = $1`,
      [activityId],
    );
    const row = rows[0];
    if (!row) return null;
    return {
      id: row.id,
      clubId: row.club_id,
      clubName: row.club_payload_name ?? row.club_id,
      title: row.title,
      description: row.description,
      status: row.status.toLowerCase(),
      deadline: row.deadline,
      departments: Array.isArray(row.departments)
        ? (row.departments as Array<{ id: string; name: string }>)
        : [],
      formId: row.form_id,
      allowAdjustmentDefault: row.allow_adjustment_default,
    };
  }

  async getPublishedFormVersions(formId: string): Promise<PublicFormVersionsView | null> {
    const { rows } = await this.pool.query<{
      version_number: number;
      fields: unknown[];
    }>(
      `SELECT version_number, fields
         FROM public.form_versions
        WHERE form_id = $1 AND status IN ('PUBLISHED', 'DRAFT')
        ORDER BY version_number ASC`,
      [formId],
    );
    if (rows.length === 0) return null;
    return {
      formId,
      versions: rows.map((r) => ({ versionNumber: Number(r.version_number), fields: r.fields ?? [] })),
    };
  }

  async findOpenChannel(activityId: string): Promise<OpenChannelView | null> {
    const { rows } = await this.pool.query<{
      id: string;
      min_choices: number;
      max_choices: number;
      deadline: string | null;
    }>(
      `SELECT id, min_choices, max_choices, deadline::text AS deadline
         FROM public.application_channels
        WHERE activity_id = $1 AND status = 'OPEN'
        ORDER BY updated_at DESC
        LIMIT 1`,
      [activityId],
    );
    const row = rows[0];
    if (!row) return null;
    return {
      id: row.id,
      minChoices: Number(row.min_choices),
      maxChoices: Number(row.max_choices),
      deadline: row.deadline,
    };
  }

  async findApplication(activityId: string, applicantId: string): Promise<ApplicationRow | null> {
    const { rows } = await this.pool.query<{
      id: string;
      activity_id: string;
      channel_id: string;
      status: string;
      department_choices: unknown[];
      form_ref: Record<string, unknown> | null;
      qualify_snapshot: Record<string, unknown> | null;
      revision_number: string | number;
      created_at: string;
      updated_at: string;
    }>(
      `SELECT id, activity_id, channel_id, status, department_choices, form_ref,
              qualify_snapshot, revision_number,
              created_at::text, updated_at::text
         FROM public.applications
        WHERE activity_id = $1 AND applicant_id = $2
        ORDER BY created_at DESC
        LIMIT 1`,
      [activityId, applicantId],
    );
    const row = rows[0];
    if (!row) return null;
    return {
      id: row.id,
      activityId: row.activity_id,
      channelId: row.channel_id,
      status: row.status,
      departmentChoices: Array.isArray(row.department_choices) ? row.department_choices : [],
      formRef: row.form_ref,
      qualifySnapshot: row.qualify_snapshot,
      revisionNumber: Number(row.revision_number),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}
