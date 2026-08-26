/**
 * 迁移：平台批准的基本资料字段目录表（4.1 收口；字段目录配置化）。
 *
 * 版本：20260826000000
 * 归属模块：identity（form 消费）
 * 说明：
 * - profile_field_directory：平台批准的基本资料字段目录（FORM-004 自动带入白名单）。
 *   目录项即 identity 可编辑白名单字段与只读权威字段（email/phone/college/grade
 *   + studentId/name）；平台级配置，字段目录变更随配置版本发布。
 * - 两态约束：可编辑（editable=true, read_only=false）或权威只读
 *   （editable=false, read_only=true），禁止既不可编辑又非权威或两者皆是的行。
 * - 种子数据：内置 6 字段（与 src/shared/models/profile-field.ts 常量一致），
 *   平台后续可增删/排序/停用；启用（enabled=true）才进入自动带入白名单。
 * - RLS 启用并放行应用层事务上下文（与 identity 其余迁移模式一致）。
 */

/** 与具体迁移工具解耦的最小查询执行器（工具选型见 DEP-Q-001，未冻结） */
export interface MigrationQueryRunner {
  query(sql: string, params?: unknown[]): Promise<unknown>;
}

export async function up(runner: MigrationQueryRunner): Promise<void> {
  await runner.query(`
    CREATE TABLE IF NOT EXISTS public.profile_field_directory (
      field_id   text        PRIMARY KEY,
      label      text        NOT NULL,
      read_only  boolean     NOT NULL,
      editable   boolean     NOT NULL,
      sort_order integer     NOT NULL DEFAULT 0,
      enabled    boolean     NOT NULL DEFAULT true,
      updated_at timestamptz NOT NULL,
      CONSTRAINT ck_profile_field_directory_kind CHECK (
        (editable AND NOT read_only) OR (NOT editable AND read_only)
      )
    )
  `);
  // 种子：内置目录（与 src/shared/models/profile-field.ts 常量一致）
  await runner.query(
    `INSERT INTO public.profile_field_directory
       (field_id, label, read_only, editable, sort_order, updated_at)
     VALUES ($1,$2,$3,$4,$5,now()),($6,$7,$8,$9,$10,now()),($11,$12,$13,$14,$15,now()),
            ($16,$17,$18,$19,$20,now()),($21,$22,$23,$24,$25,now()),($26,$27,$28,$29,$30,now())
     ON CONFLICT (field_id) DO NOTHING`,
    [
      'email',
      '邮箱',
      false,
      true,
      10,
      'phone',
      '手机号',
      false,
      true,
      20,
      'college',
      '学院',
      false,
      true,
      30,
      'grade',
      '年级',
      false,
      true,
      40,
      'studentId',
      '学号',
      true,
      false,
      50,
      'name',
      '姓名',
      true,
      false,
      60,
    ],
  );
  await runner.query(`ALTER TABLE public.profile_field_directory ENABLE ROW LEVEL SECURITY`);
  await runner.query(
    `DROP POLICY IF EXISTS p_profile_field_directory_all ON public.profile_field_directory`,
  );
  // 目录为平台级只读配置（FORM-004 白名单；应用层仅 SELECT）。写侧属平台配置命令，
  // 随配置版本发布时另行以独立写权限/维护账号收口，不放行通用写（评审建议收紧）。
  await runner.query(`
    CREATE POLICY p_profile_field_directory_all ON public.profile_field_directory
      FOR SELECT TO PUBLIC USING (true)
  `);
}

export async function down(runner: MigrationQueryRunner): Promise<void> {
  // 与 up 侧对称：先删策略、再关 RLS、最后删表（避免遗留 policy/RLS 漂移）。
  await runner.query(
    `DROP POLICY IF EXISTS p_profile_field_directory_all ON public.profile_field_directory`,
  );
  await runner.query(`ALTER TABLE public.profile_field_directory DISABLE ROW LEVEL SECURITY`);
  await runner.query(`DROP TABLE IF EXISTS public.profile_field_directory`);
}
