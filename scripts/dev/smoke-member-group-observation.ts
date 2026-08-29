/**
 * A4 Group 写链路冒烟（真库）：模拟成员激活后的观测同步 → 权限解析读回。
 * 前置：seed-org-authz.sql + 迁移 20260828110000 已应用。
 * 用法：set -a; source .env.dev.local; set +a; \
 *   RANAMINDER_CONFIG_FILE=$PWD/config.dev.yaml ORG_DB_REAL=1 \
 *   node -r ts-node/register scripts/dev/smoke-member-group-observation.ts
 */
import { loadConfig } from '../../src/config';
import { PostgresDbAdapter } from '../../src/adapters/db/postgres-db-adapter';
import { OrgUnitOfWork } from '../../src/modules/organization/infrastructure/postgres/org-unit-of-work';
import {
  PostgresGroupMappingRegistry,
  PostgresPermissionTemplateStore,
} from '../../src/modules/organization/infrastructure/postgres/postgres-config.stores';
import { PostgresClubStore } from '../../src/modules/organization/infrastructure/postgres/postgres-club.store';
import { PostgresCurrentPermissionsPort } from '../../src/modules/organization/infrastructure/postgres/postgres-current-permissions.port';
import { PostgresMemberGroupObservationWriter } from '../../src/modules/organization/infrastructure/postgres/postgres-member-group-observation.writer';

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
  const registry = new PostgresGroupMappingRegistry(db, uow);
  const writer = new PostgresMemberGroupObservationWriter(db);

  const SUBJECT = 'smoke-member-e2e-1';
  // 模拟成员激活确认：写入 CLUB + POSITION 两条关系观测（映射查 club-demo 种子）
  const clubMapping = await registry.findByClubRef('club-demo', 'club', 'club-demo');
  const posMapping = await registry.findByClubRef('club-demo', 'position', 'pos-leader-demo');
  if (!clubMapping || !posMapping) {
    console.error('SMOKE-FAIL: 种子映射缺失（先执行 seed-org-authz.sql）');
    process.exit(1);
  }
  await writer.upsertCurrentRelations(SUBJECT, [
    {
      groupOwner: clubMapping.ref.owner,
      groupName: clubMapping.ref.name,
      clubId: clubMapping.clubId,
      departmentId: clubMapping.departmentId,
      purpose: 'club',
    },
    {
      groupOwner: posMapping.ref.owner,
      groupName: posMapping.ref.name,
      clubId: posMapping.clubId,
      departmentId: posMapping.departmentId,
      purpose: 'position',
    },
  ]);
  console.log('✓ 观测写入（CLUB + POSITION）');

  const port = new PostgresCurrentPermissionsPort({
    db,
    templates: new PostgresPermissionTemplateStore(db, uow),
    clubs: new PostgresClubStore(db, uow),
    superAdminUserIds: config.org.superAdminUserIds,
  });
  const view = await port.describeForSubject(SUBJECT);
  console.log(JSON.stringify(view, null, 2));
  if (view.clubs[0]?.role !== 'club_leader') {
    console.error('SMOKE-FAIL: 角色解析应为 club_leader');
    process.exit(1);
  }
  console.log(
    '✓ 权限解析读回：role=club_leader，permissions 数=',
    view.clubs[0].permissions.length,
  );

  // 清理冒烟数据
  await writer.removeCurrentRelationsForClub(SUBJECT, 'club-demo', 'club');
  await writer.removeCurrentRelationsForClub(SUBJECT, 'club-demo', 'position');
  console.log('✓ 冒烟数据已清理');
  await db.onModuleDestroy();
}
void main().catch((e: unknown) => {
  console.error('SMOKE-FAIL', e);
  process.exit(1);
});
