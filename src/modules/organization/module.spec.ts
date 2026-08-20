import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Test } from '@nestjs/testing';

import { OrganizationModule } from './module';
import {
  ADMIN_CLUBS_QUERY,
  APPOINTMENT_COMMAND_USE_CASE,
  CASDOOR_GROUP_PORT,
  CLOCK,
  CLUB_STORE,
  CONTROLLED_BATCH_PORT,
  GROUP_DIRECTORY_QUERY,
  ONBOARDING_USE_CASE,
  ORG_CONTEXT_QUERY,
  PERMISSION_TEMPLATE_QUERY,
} from './application/ports';

describe('OrganizationModule', () => {
  it('装配：端口与用例可解析（模块接入 app.module 冒烟）', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [OrganizationModule] }).compile();
    assert.ok(moduleRef.get(CLOCK));
    assert.ok(moduleRef.get(CASDOOR_GROUP_PORT));
    assert.ok(moduleRef.get(CLUB_STORE));
    assert.ok(moduleRef.get(ONBOARDING_USE_CASE));
    assert.ok(moduleRef.get(APPOINTMENT_COMMAND_USE_CASE));
    assert.ok(moduleRef.get(ADMIN_CLUBS_QUERY));
    assert.ok(moduleRef.get(GROUP_DIRECTORY_QUERY));
    assert.ok(moduleRef.get(PERMISSION_TEMPLATE_QUERY));
    assert.ok(moduleRef.get(ORG_CONTEXT_QUERY));
    assert.ok(moduleRef.get(CONTROLLED_BATCH_PORT));
    await moduleRef.close();
  });
});
