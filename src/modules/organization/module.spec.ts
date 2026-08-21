import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Test } from '@nestjs/testing';

import { OrganizationModule } from './module';
import { AdminClubsController } from './interfaces/controllers/admin-clubs.controller';
import { AdminPermissionTemplatesController } from './interfaces/controllers/admin-permission-templates.controller';
import { OrgWorkspaceController } from './interfaces/controllers/org-workspace.controller';
import {
  ADMIN_CLUBS_QUERY,
  APPOINTMENT_COMMAND_USE_CASE,
  CASDOOR_GROUP_PORT,
  CLUB_LIFECYCLE_USE_CASE,
  CLOCK,
  CLUB_STORE,
  CONTROLLED_BATCH_PORT,
  CURRENT_PERMISSIONS_PORT,
  GROUP_DIRECTORY_QUERY,
  GROUP_MAPPING_REGISTRY,
  JOB_SCHEDULER,
  NOTIFICATION_PORT,
  ONBOARDING_USE_CASE,
  ORG_CONTEXT_QUERY,
  PERMISSION_TEMPLATE_COMMAND,
  PERMISSION_TEMPLATE_QUERY,
  PERMISSION_TEMPLATE_STORE,
  RECONCILE_PORT,
  RELATION_COMMAND_STORE,
  RELATION_COMMAND_USE_CASE,
} from './application/ports';

describe('OrganizationModule', () => {
  it('冒烟：全部端口与用例可解析（模块接入 app.module 验证）', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [OrganizationModule] }).compile();
    assert.ok(moduleRef.get(CLOCK));
    assert.ok(moduleRef.get(CASDOOR_GROUP_PORT));
    assert.ok(moduleRef.get(CLUB_STORE));
    assert.ok(moduleRef.get(RELATION_COMMAND_STORE));
    assert.ok(moduleRef.get(PERMISSION_TEMPLATE_STORE));
    assert.ok(moduleRef.get(GROUP_MAPPING_REGISTRY));
    assert.ok(moduleRef.get(RECONCILE_PORT));
    assert.ok(moduleRef.get(JOB_SCHEDULER));
    assert.ok(moduleRef.get(NOTIFICATION_PORT));
    assert.ok(moduleRef.get(CURRENT_PERMISSIONS_PORT));
    assert.ok(moduleRef.get(ONBOARDING_USE_CASE));
    assert.ok(moduleRef.get(CLUB_LIFECYCLE_USE_CASE));
    assert.ok(moduleRef.get(RELATION_COMMAND_USE_CASE));
    assert.ok(moduleRef.get(APPOINTMENT_COMMAND_USE_CASE));
    assert.ok(moduleRef.get(PERMISSION_TEMPLATE_COMMAND));
    assert.ok(moduleRef.get(ADMIN_CLUBS_QUERY));
    assert.ok(moduleRef.get(GROUP_DIRECTORY_QUERY));
    assert.ok(moduleRef.get(PERMISSION_TEMPLATE_QUERY));
    assert.ok(moduleRef.get(ORG_CONTEXT_QUERY));
    assert.ok(moduleRef.get(CONTROLLED_BATCH_PORT));
    await moduleRef.close();
  });

  it('冒烟：三个 HTTP 控制器均注册到 OrganizationModule（路由命名冻结前提）', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [OrganizationModule] }).compile();
    const adminClubs = moduleRef.get(AdminClubsController);
    const adminPerm = moduleRef.get(AdminPermissionTemplatesController);
    const orgWorkspace = moduleRef.get(OrgWorkspaceController);
    assert.ok(adminClubs instanceof AdminClubsController);
    assert.ok(adminPerm instanceof AdminPermissionTemplatesController);
    assert.ok(orgWorkspace instanceof OrgWorkspaceController);
    await moduleRef.close();
  });
});
