/**
 * 迁移：主体当前 Group 关系观测表（organization；A4 权限接线数据源）。
 *
 * 版本：20260828110000
 * 归属模块：organization
 * 说明：CAS-MAP-004 的本地"当前主体 ↔ Group 关系"观测落地——
 * 记录主体当前在哪些社团/部门/职位 Group 中（权威为 Casdoor 当前值；
 * 本表为授权解析用的本地观测，由成员生效/对账任务与联调种子写入）。
 * CurrentPermissionsPort（PostgresCurrentPermissionsPort）经
 * org_group_mapping（定位 purpose/club/department）与
 * org_position_template_binding + org_permission_template（职位→已发布模板→权限）
 * 解析逐请求权限；本表无行 = 无权限（默认拒绝，fail-closed）。
 */

/** 与具体迁移工具解耦的最小查询执行器（工具选型见 DEP-Q-001，未冻结） */
export interface MigrationQueryRunner {
  query(sql: string, params?: unknown[]): Promise<unknown>;
}

export async function up(runner: MigrationQueryRunner): Promise<void> {
  await runner.query(`
    CREATE TABLE IF NOT EXISTS public.org_member_group_current (
      subject_id   text        NOT NULL,
      group_owner  text        NOT NULL,
      group_name   text        NOT NULL,
      club_id      text        NOT NULL,
      department_id text       NULL,
      purpose      text        NOT NULL,
      observed_at  timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (subject_id, group_owner, group_name),
      CONSTRAINT ck_org_member_group_purpose CHECK (purpose IN ('club','department','position'))
    )
  `);
  await runner.query(`
    CREATE INDEX IF NOT EXISTS idx_org_member_group_club
      ON public.org_member_group_current (club_id)
  `);
}

export async function down(runner: MigrationQueryRunner): Promise<void> {
  await runner.query(`DROP INDEX IF EXISTS public.idx_org_member_group_club`);
  await runner.query(`DROP TABLE IF EXISTS public.org_member_group_current`);
}
