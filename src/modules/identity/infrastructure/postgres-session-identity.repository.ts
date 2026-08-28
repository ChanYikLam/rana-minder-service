/**
 * 会话身份建档/读取仓储（infrastructure；联调对齐接口清单 §4 / API-AUTH-001）。
 *
 * 职责：
 * - 首次登录以 Casdoor 声明建立身份档案（users + identity_profiles），回访刷新
 *   Casdoor 侧展示名；
 * - 建档后从库内读取会话快照（学号/显示名/邮箱验证/资料门状态），供
 *   GET /api/auth/session 按契约返回胖 user 结构。
 *
 * 边界：全部语句在身份域工作单元事务内执行（SEC-CTL-004 禁止脱离事务读写）；
 * 学号来源未收口前以 Casdoor 用户名兜底（开发建档规则，正式规则见 IDN 域任务）。
 */

import type { DbAdapter } from '../../../shared/db-adapter';

import { IdentityUnitOfWork } from './unit-of-work';

export interface ProvisionSessionIdentityInput {
  readonly subjectId: string;
  readonly casdoorOrg: string;
  readonly casdoorName: string;
  readonly displayName: string;
  readonly email: string | null;
  readonly emailVerifiedFromClaim: boolean;
}

export interface SessionIdentitySnapshot {
  readonly subjectId: string;
  readonly studentId: string;
  readonly name: string;
  readonly email: string | null;
  readonly phone: string;
  readonly avatar: string | null;
  readonly emailVerified: boolean;
  readonly profileComplete: boolean;
}

interface SessionIdentityRow {
  subject_id: string;
  student_id: string;
  display_name: string;
  email: string | null;
  phone: string | null;
  avatar: string | null;
  email_verified: boolean;
  gate_state: string | null;
}

export class PostgresSessionIdentityRepository {
  constructor(
    private readonly db: DbAdapter,
    private readonly uow: IdentityUnitOfWork,
  ) {}

  /**
   * 建档（幂等）并读取会话身份快照。必须在会话建立流程内调用：
   * 先以 claims 建档，再以库内状态组装响应，保证 subject 全生命周期一致。
   */
  async ensureAndRead(input: ProvisionSessionIdentityInput): Promise<SessionIdentitySnapshot> {
    return this.uow.run({ kind: 'single', subjectId: input.subjectId }, async () => {
      const tx = this.uow.active;

      // users：subject_id 稳定主键；学号以 casdoor 用户名兜底（唯一约束天然满足）
      await this.db.query(
        tx,
        `INSERT INTO users (subject_id, student_id, casdoor_org, casdoor_name, display_name)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (subject_id) DO UPDATE
           SET casdoor_name = EXCLUDED.casdoor_name,
               display_name = EXCLUDED.display_name`,
        [
          input.subjectId,
          input.casdoorName,
          input.casdoorOrg,
          input.casdoorName,
          input.displayName,
        ],
      );

      // identity_profiles：首次建档落 Casdoor 权威只读字段（studentId/name）与
      // 邮箱验证基线；已存在且已填写资料则不覆盖（fields 为空对象视为未填写）
      await this.db.query(
        tx,
        `INSERT INTO identity_profiles (subject_id, fields, email_verified, verified_email)
         VALUES ($1::text,
                 jsonb_build_object('studentId', $2::text, 'name', $3::text, 'email', $4::text),
                 $5::boolean, $4::text)
         ON CONFLICT (subject_id) DO UPDATE
           SET fields = CASE WHEN identity_profiles.fields = '{}'::jsonb
                             THEN EXCLUDED.fields
                             ELSE identity_profiles.fields END`,
        [input.subjectId, input.casdoorName, input.displayName, input.email, input.emailVerifiedFromClaim],
      );

      // account_access：Casdoor 状态已核验为 ACTIVE（DISABLED/DELETED/UNKNOWN
      // 在调用前 fail-closed 拒绝），首次建档落可信观测基线，供会话刷新读取
      await this.db.query(
        tx,
        `INSERT INTO account_access (subject_id, state, last_trusted_observation_at)
         VALUES ($1, 'ACTIVE', now())
         ON CONFLICT (subject_id) DO NOTHING`,
        [input.subjectId],
      );

      const rows = await this.db.query<SessionIdentityRow>(
        tx,
        `SELECT u.subject_id,
                u.student_id,
                u.display_name,
                COALESCE(p.fields ->> 'email', $2) AS email,
                COALESCE(p.fields ->> 'phone', '') AS phone,
                p.fields ->> 'avatar' AS avatar,
                COALESCE(p.email_verified, false) AS email_verified,
                p.gate_state AS gate_state
           FROM users u
           LEFT JOIN identity_profiles p ON p.subject_id = u.subject_id
          WHERE u.subject_id = $1`,
        [input.subjectId, input.email],
      );
      const row = rows[0];
      if (!row) {
        throw new Error('会话身份建档后读取失败：users 行缺失');
      }

      // profileComplete 口径与资料域一致：资料门 WRITABLE，或展示名+邮箱齐备
      const profileComplete =
        row.gate_state === 'WRITABLE' || Boolean(row.display_name && row.email);

      return {
        subjectId: row.subject_id,
        studentId: row.student_id,
        name: row.display_name,
        email: row.email,
        phone: row.phone ?? '',
        avatar: row.avatar,
        emailVerified: row.email_verified,
        profileComplete,
      };
    });
  }
}
