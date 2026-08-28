/**
 * 迁移：OIDC nonce/PKCE 载荷共享存储表（identity；修复联调清单 B3）。
 *
 * 版本：20260828000000
 * 归属模块：identity（会话建立前置流程）
 * 说明：进程内 nonce 存储在后端重启后丢失、多实例部署下必然校验失败。
 * 本表以共享 PostgreSQL 承载 OIDC 授权请求的一次性 nonce 与服务端私有
 * PKCE code_verifier 载荷；consume 为原子单胜者 UPDATE。
 * 表内不含个人敏感字段（nonce 为随机 UUID、payload 为随机 verifier），
 * 使用 unprotected 直连事务（无 RLS 主体上下文，先例见 profile_field_directory）。
 */

/** 与具体迁移工具解耦的最小查询执行器（工具选型见 DEP-Q-001，未冻结） */
export interface MigrationQueryRunner {
  query(sql: string, params?: unknown[]): Promise<unknown>;
}

export async function up(runner: MigrationQueryRunner): Promise<void> {
  await runner.query(`
    CREATE TABLE IF NOT EXISTS public.oidc_nonce_issues (
      nonce text PRIMARY KEY,
      payload text NOT NULL DEFAULT '',
      issued_at timestamptz NOT NULL DEFAULT now(),
      expires_at timestamptz NOT NULL,
      consumed_at timestamptz NULL
    )
  `);
  // 惰性清理按 expires_at 扫描；已消费/过期行由应用侧签发时顺带删除。
  await runner.query(
    `CREATE INDEX IF NOT EXISTS idx_oidc_nonce_issues_expires ON public.oidc_nonce_issues (expires_at)`,
  );
}

export async function down(runner: MigrationQueryRunner): Promise<void> {
  await runner.query(`DROP INDEX IF EXISTS public.idx_oidc_nonce_issues_expires`);
  await runner.query(`DROP TABLE IF EXISTS public.oidc_nonce_issues`);
}
