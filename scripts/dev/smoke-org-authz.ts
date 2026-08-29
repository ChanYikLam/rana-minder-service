/**
 * 组织端授权解析冒烟工具（A4 接线排障用）：真实 DB 上验证
 * PostgresCurrentPermissionsPort 的完整解析链（org_member_group_current →
 * 绑定 → 已发布模板 → 角色映射 → ClubStore 名称）。
 *
 * 前置：scripts/dev/seed-org-authz.sql 已执行（org_member_group_current 有行）。
 * 用法：set -a; source .env.dev.local; set +a; \
 *   RANAMINDER_CONFIG_FILE=$PWD/config.dev.yaml ORG_DB_REAL=1 \
 *   node -r ts-node/register scripts/dev/smoke-org-authz.ts [subjectId]
 *   （subjectId 缺省为联调种子 admin 主体）
 */
import { loadConfig } from '../../src/config';
import { PostgresDbAdapter } from '../../src/adapters/db/postgres-db-adapter';
import { OrgUnitOfWork } from '../../src/modules/organization/infrastructure/postgres/org-unit-of-work';
import { PostgresPermissionTemplateStore } from '../../src/modules/organization/infrastructure/postgres/postgres-config.stores';
import { PostgresClubStore } from '../../src/modules/organization/infrastructure/postgres/postgres-club.store';
import { PostgresCurrentPermissionsPort } from '../../src/modules/organization/infrastructure/postgres/postgres-current-permissions.port';

async function main(): Promise<void> {
  const config = loadConfig();
  const db = new PostgresDbAdapter({
    host: config.database.host,
    port: config.database.port,
    database: config.database.name,
    user: config.database.user,
    password: config.database.passwordRef,
    ssl: config.database.ssl,
    sslRejectUnauthorized: config.database.sslRejectUnauthorized,
    schema: config.database.schema,
  });
  const uow = new OrgUnitOfWork(db);
  const port = new PostgresCurrentPermissionsPort({
    db,
    templates: new PostgresPermissionTemplateStore(db, uow),
    clubs: new PostgresClubStore(db, uow),
    superAdminUserIds: config.org.superAdminUserIds,
  });
  const subjectId = process.argv[2] ?? 'ranaminder-dev__admin__fixed';
  const view = await port.describeForSubject(subjectId);
  console.log(JSON.stringify(view, null, 2));
  await db.onModuleDestroy();
}
void main().catch((e: unknown) => {
  console.error('SMOKE-FAIL', e);
  process.exit(1);
});
